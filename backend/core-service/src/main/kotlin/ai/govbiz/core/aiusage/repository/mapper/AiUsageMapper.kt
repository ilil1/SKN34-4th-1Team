package ai.govbiz.core.aiusage.repository.mapper

import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

data class AiUsageRecordDbRow(
    var occurredAt: LocalDateTime? = null,
    var usageDate: LocalDate? = null,
    var accountId: Long? = null,
    var feature: String? = null,
    var operation: String = "",
    var model: String = "",
    var serviceTier: String = "",
    var callCount: Int = 0,
    var inputTokens: Long = 0,
    var cachedInputTokens: Long = 0,
    var outputTokens: Long = 0,
    var estimatedCostUsd: BigDecimal? = null,
    var priceId: Long? = null,
    var cacheWriteInputTokens: Long? = null,
    var cacheWrite12hInputTokens: Long? = null,
)

data class AiModelPriceDbRow(
    var id: Long = 0,
    var modelPrefix: String = "",
    var serviceTier: String = "",
    var inputUsdPerMillion: BigDecimal = BigDecimal.ZERO,
    var cachedInputUsdPerMillion: BigDecimal? = null,
    var outputUsdPerMillion: BigDecimal = BigDecimal.ZERO,
    var effectiveFrom: LocalDate? = null,
    var note: String? = null,
    var createdByAccountId: Long? = null,
    var createdAt: LocalDateTime? = null,
    var cacheWriteInputUsdPerMillion: BigDecimal? = null,
    var cacheWrite12hInputUsdPerMillion: BigDecimal? = null,
)

/** 기간 합계 한 줄입니다. 묶는 열이 있으면 [groupKey]·[serviceTier]에, 계정별이면 계정 칸에 담습니다. */
data class AiUsageTotalsDbRow(
    var groupKey: String? = null,
    var serviceTier: String? = null,
    var accountId: Long? = null,
    var email: String? = null,
    var planCode: String? = null,
    var calls: Long = 0,
    var inputTokens: Long = 0,
    var cachedInputTokens: Long = 0,
    var outputTokens: Long = 0,
    var estimatedUsd: BigDecimal = BigDecimal.ZERO,
    var unpricedCalls: Long = 0,
    var cacheWriteInputTokens: Long? = null,
    var cacheWrite12hInputTokens: Long? = null,
    var incompleteUsageCalls: Long = 0,
)

data class AiUsageDayDbRow(
    var day: LocalDate? = null,
    var estimatedUsd: BigDecimal = BigDecimal.ZERO,
    var calls: Long = 0,
)

data class AiCostDailyDbRow(
    var costDate: LocalDate? = null,
    var projectId: String = "",
    var lineItem: String = "",
    var amountUsd: BigDecimal = BigDecimal.ZERO,
    var fetchedAt: LocalDateTime? = null,
)

data class AiProviderUsageDbRow(
    var usageDate: LocalDate? = null,
    var usageKind: String = "",
    var projectId: String = "",
    var model: String = "",
    var serviceTier: String = "",
    var batchKind: Int = -1,
    var callCount: Long = 0,
    var inputTokens: Long = 0,
    var cachedInputTokens: Long? = null,
    var cacheWriteInputTokens: Long? = null,
    var cacheWrite12hInputTokens: Long? = null,
    var outputTokens: Long = 0,
    var estimatedCostUsd: BigDecimal? = null,
    var priceId: Long? = null,
)

data class AiCostSyncDayDbRow(
    var usageDate: LocalDate? = null,
    var projectScope: String = "",
    var actualUsd: BigDecimal = BigDecimal.ZERO,
    var fetchedAt: LocalDateTime? = null,
    var totals: AiUsageTotalsDbRow = AiUsageTotalsDbRow(),
)

@Mapper
interface AiUsageMapper {
    fun insertUsage(row: AiUsageRecordDbRow): Int

    fun findPrices(): List<AiModelPriceDbRow>

    fun insertPrice(row: AiModelPriceDbRow): Int

    fun sumTotals(@Param("from") from: LocalDate, @Param("to") to: LocalDate, @Param("accountId") accountId: Long?, @Param("utc") utc: Boolean = false): AiUsageTotalsDbRow

    fun sumByFeature(@Param("from") from: LocalDate, @Param("to") to: LocalDate): List<AiUsageTotalsDbRow>

    fun sumByModel(@Param("from") from: LocalDate, @Param("to") to: LocalDate): List<AiUsageTotalsDbRow>

    fun sumByDay(@Param("from") from: LocalDate, @Param("to") to: LocalDate): List<AiUsageDayDbRow>

    fun sumTopAccounts(@Param("from") from: LocalDate, @Param("to") to: LocalDate, @Param("limit") limit: Int): List<AiUsageTotalsDbRow>

    fun sumActualByDay(@Param("from") from: LocalDate, @Param("to") to: LocalDate): List<AiUsageDayDbRow>

    fun findActualFetchedAt(): LocalDateTime?

    fun deleteActualCosts(@Param("from") from: LocalDate, @Param("to") to: LocalDate): Int

    fun insertActualCost(row: AiCostDailyDbRow): Int

    fun deleteProviderUsage(@Param("from") from: LocalDate, @Param("to") to: LocalDate): Int

    fun insertProviderUsage(row: AiProviderUsageDbRow): Int

    fun deleteSyncDays(@Param("from") from: LocalDate, @Param("to") to: LocalDate): Int

    fun insertSyncDay(row: AiCostSyncDayDbRow): Int

    fun findProviderDays(@Param("from") from: LocalDate, @Param("to") to: LocalDate, @Param("scope") scope: String): List<AiCostSyncDayDbRow>

    fun lockLatestSyncStartedAt(): LocalDateTime?

    fun updateLatestSyncStartedAt(@Param("startedAt") startedAt: LocalDateTime): Int
}
