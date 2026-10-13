package ai.govbiz.core.aiusage.repository

import ai.govbiz.core.aiusage.repository.mapper.AiCostSyncDayDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiUsageMapper
import ai.govbiz.core.aiusage.repository.mapper.AiUsageTotalsDbRow
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito

/** SQL 실행을 대신하지 않고, 읽어 온 날짜의 누락·미확인 사용량을 비교 가능으로 표시하지 않는 정책을 검증합니다. */
class AiCostComparisonTest {
    private val mapper = Mockito.mock(AiUsageMapper::class.java)
    private val repository = AiUsageRepository(mapper)
    private val from = LocalDate.of(2026, 10, 12)
    private val to = from.plusDays(1)
    private val fetchedAt = LocalDateTime.of(2026, 10, 14, 1, 49)

    @Test
    fun missingCoverageHasNoComparisonAmountsWhereasSynchronizedEmptyDaysAreKnownZero() {
        Mockito.doReturn(emptyList<AiCostSyncDayDbRow>()).`when`(mapper).findProviderDays(from, to, "proj")
        val missing = repository.comparison(from, to, "proj", to.plusDays(1))
        assertEquals("not-synced", missing.status)
        assertNull(missing.totals)
        assertNull(missing.actualUsd)
        assertNull(missing.fetchedAt)
        assertTrue(missing.days.all { it.actualUsd == null })

        Mockito.doReturn(listOf(day(from), day(to))).`when`(mapper).findProviderDays(from, to, "proj")
        val zero = repository.comparison(from, to, "proj", to.plusDays(1))
        assertEquals("ready", zero.status)
        assertEquals(0L, zero.totals?.calls)
        assertEquals(BigDecimal.ZERO, zero.totals?.estimatedUsd)
        assertEquals(BigDecimal.ZERO, zero.actualUsd)
        assertEquals(0L, zero.totals?.cacheWriteInputTokens)
        assertEquals(0L, zero.totals?.cacheWrite12hInputTokens)
        assertTrue(zero.days.all { it.actualUsd == BigDecimal.ZERO })
    }

    @Test
    fun anUnsynchronizedDayBetweenTwoKnownDaysCannotProduceAMisleadingPeriodGap() {
        val end = from.plusDays(2)
        Mockito.doReturn(listOf(
            day(from, actual = BigDecimal("0.1"), totals = knownTotals(3, "0.09")),
            day(end, actual = BigDecimal("0.2"), totals = knownTotals(5, "0.19")),
        )).`when`(mapper).findProviderDays(from, end, "proj")

        val result = repository.comparison(from, end, "proj", end.plusDays(1))

        assertEquals("incomplete", result.status)
        assertNull(result.totals)
        assertNull(result.actualUsd)
        assertEquals(listOf(from, from.plusDays(1), end), result.days.map { it.date })
        assertNull(result.days[1].actualUsd)
        assertEquals(BigDecimal("0.1"), result.days[0].actualUsd)
        assertEquals(BigDecimal("0.2"), result.days[2].actualUsd)
    }

    @Test
    fun currentDayAndOldestFetchTimeRemainVisibleForCompleteButProvisionalUsage() {
        Mockito.doReturn(listOf(
            day(from, at = fetchedAt.minusHours(24), actual = BigDecimal("0.10"), totals = knownTotals(2, "0.09")),
            day(to, actual = BigDecimal("0.20"), totals = knownTotals(3, "0.18")),
        )).`when`(mapper).findProviderDays(from, to, "proj")

        val provisional = repository.comparison(from, to, "proj", to)
        assertEquals("ready", provisional.status)
        assertTrue(provisional.includesCurrentDay)
        assertEquals(fetchedAt.minusHours(24), provisional.fetchedAt)
        assertEquals(5L, provisional.totals?.calls)
        assertEquals(BigDecimal("0.27"), provisional.totals?.estimatedUsd)
        assertEquals(BigDecimal("0.30"), provisional.actualUsd)
        assertFalse(repository.comparison(from, to, "proj", to.plusDays(1)).includesCurrentDay)
    }

    @Test
    fun unknownCacheWritesAndUnpricedCallsRemainIncompleteInsteadOfBeingConvertedToZero() {
        val unknown = AiUsageTotalsDbRow(
            calls = 2, inputTokens = 100, cachedInputTokens = 10, outputTokens = 5,
            estimatedUsd = BigDecimal.ZERO, unpricedCalls = 2,
            cacheWriteInputTokens = null, cacheWrite12hInputTokens = null, incompleteUsageCalls = 2,
        )
        Mockito.doReturn(listOf(day(from, totals = unknown), day(to, totals = knownTotals(1, "0.001"))))
            .`when`(mapper).findProviderDays(from, to, "proj")

        val result = repository.comparison(from, to, "proj", to.plusDays(1))

        assertEquals("ready", result.status) // 수집 범위가 완전함을 뜻하며 가격 계산의 완전함과 다릅니다.
        assertEquals(3L, result.totals?.calls)
        assertEquals(2L, result.totals?.unpricedCalls)
        assertEquals(2L, result.totals?.incompleteUsageCalls)
        assertNull(result.totals?.cacheWriteInputTokens)
        assertNull(result.totals?.cacheWrite12hInputTokens)
        assertEquals(BigDecimal("0.001"), result.totals?.estimatedUsd)
    }

    @Test
    fun switchingProjectScopeCannotReuseAnotherProjectsStoredCoverage() {
        Mockito.doReturn(listOf(day(from), day(to))).`when`(mapper).findProviderDays(from, to, "proj")
        Mockito.doReturn(emptyList<AiCostSyncDayDbRow>()).`when`(mapper).findProviderDays(from, to, "other-project")

        assertEquals("ready", repository.comparison(from, to, "proj", to).status)
        assertEquals("not-synced", repository.comparison(from, to, "other-project", to).status)
        Mockito.verify(mapper).findProviderDays(from, to, "proj")
        Mockito.verify(mapper).findProviderDays(from, to, "other-project")
        Mockito.verifyNoMoreInteractions(mapper)
    }

    private fun knownTotals(calls: Long = 0, estimated: String = "0") = AiUsageTotalsDbRow(
        calls = calls, estimatedUsd = BigDecimal(estimated), cacheWriteInputTokens = 0, cacheWrite12hInputTokens = 0,
    )

    private fun day(date: LocalDate, at: LocalDateTime = fetchedAt, actual: BigDecimal = BigDecimal.ZERO, totals: AiUsageTotalsDbRow = knownTotals()) =
        AiCostSyncDayDbRow(date, "proj", actual, at, totals)
}
