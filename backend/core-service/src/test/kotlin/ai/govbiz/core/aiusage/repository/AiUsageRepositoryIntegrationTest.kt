package ai.govbiz.core.aiusage.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.domain.AiUsageAttribution
import ai.govbiz.core.aiusage.domain.AiUsageFeature
import ai.govbiz.core.aiusage.domain.NewAiModelPrice
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import ai.govbiz.core.aiusage.domain.OpenAiUsageLine
import ai.govbiz.core.aiusage.service.AiUsageService
import ai.govbiz.core.aiusage.service.exception.AiModelPriceConflictException
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/** 실제 MySQL 8.4에서 AI 사용 기록·가격표·실제 비용의 저장과 기간 합계, 기능 transaction과 따로 남는 기록, 제약을 확인합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.application-document.jobs.enabled=false",
    "app.ai-cost.sync-enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class AiUsageRepositoryIntegrationTest {
    @Autowired private lateinit var service: AiUsageService
    @Autowired private lateinit var repository: AiUsageRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactionManager: PlatformTransactionManager
    private val today = LocalDate.now(ZoneId.of("Asia/Seoul"))

    @Test
    fun recordsPricedAndUnpricedUsageAndSumsItByFeatureModelDayAndAccount() {
        val member = account()
        val actor = AdminActor(account(), "198.51.100.7", null)
        val before = repository.sumTotals(today, today)
        service.record(
            "support-program-rankings/rank",
            listOf(
                AiModelUsage("gpt-5.6-sol-2026-07-30", "priority", 1, 10_000, 4_000, 500, 0, 0),
                AiModelUsage("gpt-unknown-1", "default", 2, 100, 0, 10, 0, 0),
            ),
            AiUsageAttribution(member, AiUsageFeature.AI_SEARCH),
        )
        service.record("support-program-index/batch", listOf(AiModelUsage("text-embedding-3-small", "default", 3, 1_000_000, 0, 0, 0, 0)), null)

        // gpt-5.6-sol Fast: 6,000 × 8 + 4,000 × 0.8 + 500 × 40 = 48,000 + 3,200 + 20,000 micro-USD = 0.0712
        val mine = repository.sumTotals(today, today, member)
        assertEquals(3, mine.calls)
        assertEquals(0, BigDecimal("0.0712").compareTo(mine.estimatedUsd))
        assertEquals(2, mine.unpricedCalls)
        val all = repository.sumTotals(today, today)
        assertEquals(before.calls + 6, all.calls)
        assertEquals(0, (before.estimatedUsd + BigDecimal("0.0912")).compareTo(all.estimatedUsd))

        val utcToday = LocalDate.now(java.time.ZoneOffset.UTC)
        val summary = service.summary(actor.let { AdminActor.of(it.accountId, it.clientIp, it.userAgent) }, utcToday, utcToday)
        assertTrue(summary.byFeature.any { it.key == "AI_SEARCH" && it.totals.calls >= 3 })
        assertTrue(summary.byFeature.any { it.key == null && it.totals.calls >= 3 })
        assertTrue(summary.byModel.any { it.key == "gpt-5.6-sol-2026-07-30" && it.serviceTier == "priority" })
        assertTrue(summary.topAccounts.any { it.accountId == member && it.email.startsWith("ai-usage-") })
        assertEquals(utcToday, summary.days.single().date)
        assertEquals(1, jdbc.queryForObject(
            "SELECT COUNT(*) FROM admin_access_log WHERE action = 'AI_COST_VIEW' AND actor_account_id = ?", Int::class.java, actor.accountId))
    }

    @Test
    fun usageStaysRecordedWhenTheCallingFeatureRollsBack() {
        val member = account()
        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactionManager).execute {
                service.record("combination-reviews/analyze", listOf(AiModelUsage("gpt-5.6-luna", "default", 1, 10, 0, 5, 0, 0)),
                    AiUsageAttribution(member, AiUsageFeature.COMBINATION_REVIEW))
                error("기능 실패")
            }
        }
        assertEquals(1, repository.sumTotals(today, today, member).calls)
    }

    @Test
    fun seededPricesCoverTheModelsWeUseAndNewPricesAreAddedNotEdited() {
        val prices = repository.findPrices()
        listOf("gpt-5.6-sol" to "priority", "gpt-5.6-luna" to "default", "gpt-6-luna" to "default", "gpt-5-nano" to "default",
            "text-embedding-3-small" to "default").forEach { (model, tier) ->
            assertTrue(prices.any { it.modelPrefix == model && it.serviceTier == tier }, "$model $tier")
        }
        val admin = account()
        val price = NewAiModelPrice("gpt-test-${UUID.randomUUID().toString().take(8)}", "flex", BigDecimal("0.1"), null, BigDecimal("0.5"), today, "테스트")
        service.addPrice(AdminActor.of(admin, "198.51.100.7", null), price)
        assertThrows(AiModelPriceConflictException::class.java) { service.addPrice(AdminActor.of(admin, "198.51.100.7", null), price) }
        assertNull(repository.findPrices().single { it.modelPrefix == price.modelPrefix }.cachedInputUsdPerMillion)
    }

    @Test
    fun actualCostsReplaceOnlyTheFetchedDays() {
        val base = LocalDate.of(2020, 1, 10)
        val fetchedAt = LocalDateTime.of(2026, 10, 10, 10, 10)
        repository.replaceActualCosts(base, base.plusDays(1), listOf(
            OpenAiCostLine(base, "proj", "gpt-5.6-luna, input", BigDecimal("0.5")),
            OpenAiCostLine(base.plusDays(1), "proj", "gpt-5.6-luna, 출력", BigDecimal("1.25")),
        ), fetchedAt)
        repository.replaceActualCosts(base.plusDays(1), base.plusDays(1), listOf(
            OpenAiCostLine(base.plusDays(1), "proj", "gpt-5.6-luna, 출력", BigDecimal("2")),
        ), fetchedAt)

        val days = repository.sumActualByDay(base, base.plusDays(1))
        assertEquals(0, BigDecimal("0.5").compareTo(days[base]))
        assertEquals(0, BigDecimal("2").compareTo(days[base.plusDays(1)]))
    }

    @Test
    fun theDatabaseRejectsUnknownFeaturesImpossibleTokensAndUnknownTiers() {
        listOf(
            "INSERT INTO ai_usage_record (occurred_at, usage_date, feature, operation, model, service_tier, call_count, input_tokens, cached_input_tokens, output_tokens) VALUES (NOW(6), CURDATE(), 'CHAT', 'op', 'm', 'default', 1, 1, 0, 0)",
            "INSERT INTO ai_usage_record (occurred_at, usage_date, operation, model, service_tier, call_count, input_tokens, cached_input_tokens, output_tokens) VALUES (NOW(6), CURDATE(), 'op', 'm', 'default', 1, 1, 2, 0)",
            "INSERT INTO ai_usage_record (occurred_at, usage_date, operation, model, service_tier, call_count, input_tokens, cached_input_tokens, output_tokens) VALUES (NOW(6), CURDATE(), 'op', 'm', 'default', 0, 1, 0, 0)",
            "INSERT INTO ai_model_price (model_prefix, service_tier, input_usd_per_million, output_usd_per_million, effective_from, created_at) VALUES ('gpt-x', 'scale', 1, 1, CURDATE(), NOW(6))",
            "INSERT INTO ai_model_price (model_prefix, service_tier, input_usd_per_million, output_usd_per_million, effective_from, created_at) VALUES ('gpt-x', 'default', -1, 1, CURDATE(), NOW(6))",
        ).forEach { sql -> assertThrows(DataAccessException::class.java) { jdbc.update(sql) } }
    }

    @Test
    fun providerSnapshotIncludesCallsOutsideCoreAndComparesZeroDaysWithoutDoubleCounting() {
        val day = LocalDate.of(2031, 10, 12)
        val at = day.plusDays(1).atTime(4, 0)
        val usages = listOf(
            providerUsage(day, "gpt-6-luna", 26, 482235, 12036, 470121, 32095),
            providerUsage(day, "gpt-5-nano-2025-08-07", 3, 5256, 0, 0, 268),
            providerUsage(day, "text-embedding-3-small", 15, 1867, 0, 0, 0).copy(usageKind = "embeddings", batch = null),
        )
        val costs = listOf(OpenAiCostLine(day, "proj", "한국어 캐시 쓰기 · output", BigDecimal("0.075348125")))
        repeat(2) { repository.replaceCostSnapshot(day, day.plusDays(1), usages, costs, "proj", at, syncStartedAt()) }

        val comparison = repository.comparison(day, day.plusDays(1), "proj", day.plusDays(2))
        assertEquals("ready", comparison.status)
        assertEquals(44, comparison.totals!!.calls)
        assertEquals(470121, comparison.totals.cacheWriteInputTokens)
        assertEquals(0, BigDecimal("0.075348125").compareTo(comparison.totals.estimatedUsd))
        assertEquals(0, comparison.actualUsd!!.compareTo(comparison.totals.estimatedUsd))
        assertEquals(0, comparison.days.last().actualUsd!!.signum())
        assertEquals(0, comparison.days.last().totals.calls)
        assertEquals(0, repository.sumTotals(day, day.plusDays(1), utc = true).calls)
        assertEquals("not-synced", repository.comparison(day, day.plusDays(1), "other-project", day).status)
        assertEquals("incomplete", repository.comparison(day.minusDays(1), day, "proj", day).status)
        assertNull(repository.comparison(day.minusDays(1), day, "proj", day).actualUsd)
        assertEquals(at, comparison.fetchedAt)
    }

    @Test
    fun partialSnapshotWriteRollsBackUsageCostsAndCoverageTogether() {
        val day = LocalDate.of(2031, 11, 1)
        val at = day.atTime(12, 0)
        val usage = providerUsage(day, "gpt-6-luna", 1, 103, 0, 100, 10)
        val cost = OpenAiCostLine(day, "proj", "input", BigDecimal("0.0000178"))
        val startedAt = syncStartedAt()
        repository.replaceCostSnapshot(day, day, listOf(usage), listOf(cost), "proj", at, startedAt)
        assertThrows(DataAccessException::class.java) {
            repository.replaceCostSnapshot(day, day, listOf(usage, usage), listOf(cost.copy(amountUsd = BigDecimal.TEN)), "proj", at.plusHours(1), startedAt.plusHours(1))
        }
        val comparison = repository.comparison(day, day, "proj", day)
        assertEquals(1, comparison.totals!!.calls)
        assertEquals(at, comparison.fetchedAt)
        assertEquals(0, cost.amountUsd.compareTo(comparison.actualUsd))
        assertEquals(0, cost.amountUsd.compareTo(repository.sumActualByDay(day, day)[day]))
        assertEquals(startedAt, storedSyncStartedAt())
    }

    @Test
    fun unknownCacheCountersAndUnsupportedBatchRemainUnpriced() {
        val day = LocalDate.of(2031, 12, 1)
        val unknown = providerUsage(day, "gpt-6-luna", 1, 103, 0, 100, 10).copy(cacheWriteTokens = null)
        val batch = providerUsage(day, "gpt-6-luna", 2, 203, 0, 200, 20).copy(batch = true)
        repository.replaceCostSnapshot(day, day, listOf(unknown, batch), emptyList(), "proj", day.atTime(12, 0), syncStartedAt())
        val totals = repository.comparison(day, day, "proj", day).totals!!
        assertEquals(3, totals.unpricedCalls)
        assertEquals(1, totals.incompleteUsageCalls)
        assertNull(totals.cacheWriteInputTokens)
        assertEquals(0, totals.estimatedUsd.signum())
    }

    @Test
    fun aSlowOlderCollectionCannotOverwriteANewerSnapshotEvenIfItFinishesLater() {
        val day = LocalDate.of(2033, 1, 1)
        val oldStartedAt = syncStartedAt()
        val newStartedAt = oldStartedAt.plusNanos(1000)
        val latestFinishedAt = day.atTime(12, 0)
        val newerUsage = providerUsage(day, "gpt-6-luna", 2, 203, 0, 200, 20)
        val newerCost = OpenAiCostLine(day, "proj", "input", BigDecimal("0.25"))
        repository.replaceCostSnapshot(day, day, listOf(newerUsage), listOf(newerCost), "proj", latestFinishedAt, newStartedAt)

        assertThrows(java.util.ConcurrentModificationException::class.java) {
            repository.replaceCostSnapshot(day, day, emptyList(), emptyList(), "proj", latestFinishedAt.plusHours(1), oldStartedAt)
        }

        val comparison = repository.comparison(day, day, "proj", day)
        assertEquals(2, comparison.totals!!.calls)
        assertEquals(0, newerCost.amountUsd.compareTo(comparison.actualUsd))
        assertEquals(latestFinishedAt, comparison.fetchedAt)
        assertEquals(newStartedAt, storedSyncStartedAt())
    }

    @Test
    fun snapshotStateAndDataRollBackTogetherWhenTheCallerTransactionFails() {
        val day = LocalDate.of(2033, 2, 1)
        val startedAt = syncStartedAt()
        val at = day.atTime(12, 0)
        val cost = OpenAiCostLine(day, "proj", "input", BigDecimal("0.25"))
        repository.replaceCostSnapshot(day, day, emptyList(), listOf(cost), "proj", at, startedAt)

        assertThrows(IllegalStateException::class.java) {
            TransactionTemplate(transactionManager).execute {
                repository.replaceCostSnapshot(day, day, emptyList(), emptyList(), "proj", at.plusHours(1), startedAt.plusHours(1))
                error("저장 후 상위 transaction 실패")
            }
        }

        assertEquals(startedAt, storedSyncStartedAt())
        val comparison = repository.comparison(day, day, "proj", day)
        assertEquals(at, comparison.fetchedAt)
        assertEquals(0, cost.amountUsd.compareTo(comparison.actualUsd))
        // 실패한 수집의 미래 시작시각이 남았다면 이 정상 재시도도 거절된다.
        repository.replaceCostSnapshot(day, day, emptyList(), listOf(cost), "proj", at, syncStartedAt())
    }

    @Test
    fun utcAppPeriodIncludesNineAmBoundaryAndMonthlyAccountTotalsRemainSeoulBased() {
        val day = LocalDate.of(2032, 1, 1)
        val member = account()
        val usage = AiModelUsage("text-embedding-3-small", "default", 1, 1, 0, 0, 0, 0)
        val price = repository.findPrices().first { it.modelPrefix == "text-embedding-3-small" }
        listOf(day.atTime(8, 59, 59), day.atTime(9, 0), day.plusDays(1).atTime(8, 59, 59), day.plusDays(1).atTime(9, 0)).forEach {
            repository.insertUsage(it, AiUsageAttribution(member, AiUsageFeature.AI_SEARCH), "utc-boundary", usage, price)
        }
        assertEquals(2, repository.sumTotals(day, day, member, utc = true).calls)
        assertEquals(1, repository.sumTotals(day.minusDays(1), day.minusDays(1), member, utc = true).calls)
        assertEquals(2, repository.sumTotals(day, day, member).calls)
        assertEquals(2, repository.sumByDay(day, day)[day]!!.second)
        assertEquals(2, repository.sumByFeature(day, day).single().totals.calls)
        assertEquals(2, repository.sumTopAccounts(day, day, 10).single().totals.calls)
    }

    private fun providerUsage(day: LocalDate, model: String, calls: Long, input: Long, cached: Long, writes: Long, output: Long) =
        OpenAiUsageLine(day, "completions", "proj", model, "default", calls, input, cached, writes, 0, output, false)

    private fun syncStartedAt(): LocalDateTime = LocalDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS)

    private fun storedSyncStartedAt(): LocalDateTime? =
        jdbc.queryForObject("SELECT started_at FROM ai_cost_sync_state WHERE singleton_id = 1", LocalDateTime::class.java)

    private fun account(): Long =
        accounts.createAccount(NewAccount("ai-usage-${UUID.randomUUID()}@example.test", "test-password-hash", LocalDateTime.of(2026, 10, 1, 0, 0))).id
}
