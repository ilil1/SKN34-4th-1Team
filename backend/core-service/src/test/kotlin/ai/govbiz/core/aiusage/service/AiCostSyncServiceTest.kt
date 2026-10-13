package ai.govbiz.core.aiusage.service

import ai.govbiz.core.aiusage.client.OpenAiCostsClient
import ai.govbiz.core.aiusage.client.OpenAiUsageClient
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.config.AiCostProperties
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import ai.govbiz.core.aiusage.domain.OpenAiUsageLine
import ai.govbiz.core.aiusage.domain.OpenAiUsageSnapshot
import ai.govbiz.core.aiusage.repository.AiUsageRepository
import ai.govbiz.core.aiusage.service.exception.AiCostSyncException
import java.math.BigDecimal
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito

class AiCostSyncServiceTest {
    // 서울 2026-10-11 08:30 = UTC 2026-10-10 23:30. OpenAI 하루는 UTC라 오늘은 10월 10일입니다.
    private val clock = Clock.fixed(Instant.parse("2026-10-10T23:30:00Z"), ZoneId.of("Asia/Seoul"))
    private val client = Mockito.mock(OpenAiCostsClient::class.java)
    private val usageClient = Mockito.mock(OpenAiUsageClient::class.java)
    private val repository = Mockito.mock(AiUsageRepository::class.java)
    private val from = LocalDate.of(2026, 10, 8)
    private val to = LocalDate.of(2026, 10, 10)

    private fun service(key: String = "admin-key", testClock: Clock = clock) =
        AiCostSyncService(client, usageClient, repository, AiCostProperties(openaiAdminKey = key, openaiProjectId = "proj", syncDays = 3), testClock)

    @Test
    fun withoutAnAdminKeyNothingIsCalled() {
        assertEquals(AiCostSyncException.Reason.ADMIN_KEY_MISSING, assertThrows(AiCostSyncException::class.java) { service(" ").sync() }.reason)
        Mockito.verifyNoInteractions(client, usageClient, repository)
    }

    @Test
    fun savesUsageAndCostsTogetherWithTheSameUtcPeriodScopeAndFetchTime() {
        val day = LocalDate.of(2026, 10, 9)
        val usage = listOf(
            OpenAiUsageLine(day, "completions", "proj", "gpt-6-luna", "default", 2, 100, 10, 40, 20, 15, false),
            OpenAiUsageLine(day, "embeddings", "proj", "text-embedding-3-small", "default", 110, 656_873, 0, 0, 0, 0),
        )
        Mockito.doReturn(
            listOf(
                OpenAiCostLine(day, "proj", "gpt-5.6-luna, input", BigDecimal("0.10")),
                OpenAiCostLine(day, "proj", "gpt-5.6-luna, input", BigDecimal("0.05")),
                OpenAiCostLine(day.plusDays(1), "proj", "gpt-5.6-luna, output", BigDecimal("0.20")),
            ),
        ).`when`(client).fetch(from, to.plusDays(1))
        Mockito.doReturn(snapshot(usage)).`when`(usageClient).fetch(from, to.plusDays(1))

        val result = service().sync()

        assertEquals(2, result.lines)
        assertEquals(BigDecimal("0.35"), result.amountUsd)
        assertEquals(from, result.from)
        assertEquals(to, result.to)
        val order = Mockito.inOrder(client, usageClient, repository)
        order.verify(client).fetch(from, to.plusDays(1))
        order.verify(usageClient).fetch(from, to.plusDays(1))
        order.verify(repository).replaceCostSnapshot(
            from,
            to,
            usage,
            listOf(
                OpenAiCostLine(day, "proj", "gpt-5.6-luna, input", BigDecimal("0.15")),
                OpenAiCostLine(day.plusDays(1), "proj", "gpt-5.6-luna, output", BigDecimal("0.20")),
            ),
            "proj",
            LocalDateTime.of(2026, 10, 10, 23, 30),
            LocalDateTime.of(2026, 10, 10, 23, 30),
        )
        Mockito.verifyNoMoreInteractions(repository)
    }

    @Test
    fun aRejectedKeyKeepsTheStoredCosts() {
        Mockito.doThrow(OpenAiCostsClientException(OpenAiCostsClientException.Reason.REJECTED)).`when`(client)
            .fetch(from, to.plusDays(1))

        assertEquals(AiCostSyncException.Reason.ADMIN_KEY_REJECTED, assertThrows(AiCostSyncException::class.java) { service().sync() }.reason)
        Mockito.verifyNoInteractions(usageClient, repository)
    }

    @Test
    fun aUsageFailureCannotReplaceSuccessfullyFetchedCostsOrCoverage() {
        for ((failure, expected) in listOf(
            OpenAiCostsClientException.Reason.REJECTED to AiCostSyncException.Reason.ADMIN_KEY_REJECTED,
            OpenAiCostsClientException.Reason.INVALID_RESPONSE to AiCostSyncException.Reason.INVALID_RESPONSE,
            OpenAiCostsClientException.Reason.UNAVAILABLE to AiCostSyncException.Reason.UNAVAILABLE,
        )) {
            Mockito.doReturn(listOf(OpenAiCostLine(from, "proj", "input", BigDecimal("0.25"))))
                .`when`(client).fetch(from, to.plusDays(1))
            Mockito.doThrow(OpenAiCostsClientException(failure)).`when`(usageClient).fetch(from, to.plusDays(1))
            assertEquals(expected, assertThrows(AiCostSyncException::class.java) { service().sync() }.reason)
            Mockito.verifyNoInteractions(repository)
            Mockito.reset(client, usageClient)
        }
    }

    @Test
    fun emptySuccessfulDaysAreSavedSoTheyCanBeComparedAsZeroInsteadOfNotFetched() {
        Mockito.doReturn(emptyList<OpenAiCostLine>()).`when`(client).fetch(from, to.plusDays(1))
        Mockito.doReturn(snapshot(emptyList())).`when`(usageClient).fetch(from, to.plusDays(1))

        val result = service().sync()

        assertEquals(0, result.lines)
        assertEquals(BigDecimal.ZERO, result.amountUsd)
        Mockito.verify(repository).replaceCostSnapshot(
            from, to, emptyList(), emptyList(), "proj", LocalDateTime.of(2026, 10, 10, 23, 30), LocalDateTime.of(2026, 10, 10, 23, 30),
        )
    }

    @Test
    fun collectionStartPrecedesApiCallsAndRemainsSeparateFromCompletionTime() {
        val advancingClock = Mockito.mock(Clock::class.java)
        Mockito.`when`(advancingClock.zone).thenReturn(ZoneOffset.UTC)
        Mockito.`when`(advancingClock.withZone(ZoneOffset.UTC)).thenReturn(advancingClock)
        Mockito.`when`(advancingClock.instant()).thenReturn(
            Instant.parse("2026-10-10T23:30:00Z"), Instant.parse("2026-10-11T00:01:00Z"),
        )
        Mockito.doReturn(emptyList<OpenAiCostLine>()).`when`(client).fetch(from, to.plusDays(1))
        Mockito.doReturn(snapshot(emptyList())).`when`(usageClient).fetch(from, to.plusDays(1))

        service(testClock = advancingClock).sync()

        // 자정을 넘겨 수집이 끝나도 요청 기간은 시작할 때 정한 UTC 날짜를 유지한다.
        Mockito.verify(repository).replaceCostSnapshot(
            from, to, emptyList(), emptyList(), "proj",
            LocalDateTime.of(2026, 10, 11, 0, 1), LocalDateTime.of(2026, 10, 10, 23, 30),
        )
    }

    @Test
    fun anOlderSnapshotRejectedByTheRepositoryIsAnUnavailableSync() {
        val at = LocalDateTime.of(2026, 10, 10, 23, 30)
        Mockito.doReturn(emptyList<OpenAiCostLine>()).`when`(client).fetch(from, to.plusDays(1))
        Mockito.doReturn(snapshot(emptyList())).`when`(usageClient).fetch(from, to.plusDays(1))
        Mockito.doThrow(java.util.ConcurrentModificationException("newer snapshot exists")).`when`(repository)
            .replaceCostSnapshot(from, to, emptyList(), emptyList(), "proj", at, at)

        assertEquals(AiCostSyncException.Reason.UNAVAILABLE, assertThrows(AiCostSyncException::class.java) { service().sync() }.reason)
    }

    private fun snapshot(lines: List<OpenAiUsageLine>) =
        OpenAiUsageSnapshot(from, to.plusDays(1), lines, from.datesUntil(to.plusDays(1)).toList().toSet())
}
