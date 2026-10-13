package ai.govbiz.core.aiusage.controller.dto

import ai.govbiz.core.aiusage.domain.AiCostSummary
import ai.govbiz.core.aiusage.domain.AiCostSyncResult
import ai.govbiz.core.aiusage.domain.AiCostComparison
import ai.govbiz.core.aiusage.domain.AiModelPrice
import ai.govbiz.core.aiusage.domain.AiUsageGroup
import ai.govbiz.core.aiusage.domain.AiUsageTotals
import ai.govbiz.core.aiusage.domain.NewAiModelPrice
import jakarta.validation.constraints.DecimalMin
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private fun BigDecimal.usd(): String = setScale(6, RoundingMode.HALF_UP).toPlainString()

/** 금액은 소수 6자리 USD 문자열입니다(부동소수 오차 없이 보이기 위해). */
data class AdminAiUsageTotalsResponse(
    val calls: Long,
    val inputTokens: Long,
    val cachedInputTokens: Long,
    val outputTokens: Long,
    val estimatedUsd: String,
    val unpricedCalls: Long,
    val cacheWriteInputTokens: Long?,
    val cacheWrite12hInputTokens: Long?,
    val incompleteUsageCalls: Long,
) {
    companion object {
        fun from(totals: AiUsageTotals) = AdminAiUsageTotalsResponse(
            totals.calls, totals.inputTokens, totals.cachedInputTokens, totals.outputTokens, totals.estimatedUsd.usd(), totals.unpricedCalls,
            totals.cacheWriteInputTokens, totals.cacheWrite12hInputTokens, totals.incompleteUsageCalls,
        )
    }
}

data class AdminAiUsageGroupResponse(val key: String?, val serviceTier: String?, val totals: AdminAiUsageTotalsResponse) {
    companion object {
        fun from(group: AiUsageGroup) = AdminAiUsageGroupResponse(group.key, group.serviceTier, AdminAiUsageTotalsResponse.from(group.totals))
    }
}

data class AdminAiCostDayResponse(val date: String, val estimatedUsd: String, val calls: Long, val actualUsd: String?)

data class AdminAiUsageAccountResponse(val accountId: Long, val email: String, val planCode: String?, val totals: AdminAiUsageTotalsResponse)

data class AdminAiCostComparisonDayResponse(val date: String, val totals: AdminAiUsageTotalsResponse, val actualUsd: String?)

data class AdminAiCostComparisonResponse(
    val timezone: String,
    val from: String,
    val to: String,
    val fetchedAt: String?,
    val status: String,
    val includesCurrentDay: Boolean,
    val totals: AdminAiUsageTotalsResponse?,
    val actualUsd: String?,
    val days: List<AdminAiCostComparisonDayResponse>,
) {
    companion object {
        fun from(value: AiCostComparison) = AdminAiCostComparisonResponse(
            "UTC", value.from.toString(), value.to.toString(), value.fetchedAt?.atOffset(ZoneOffset.UTC)?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            value.status, value.includesCurrentDay, value.totals?.let(AdminAiUsageTotalsResponse::from), value.actualUsd?.usd(),
            value.days.map { AdminAiCostComparisonDayResponse(it.date.toString(), AdminAiUsageTotalsResponse.from(it.totals), it.actualUsd?.usd()) },
        )
    }
}

data class AdminAiCostSummaryResponse(
    val from: String,
    val to: String,
    val totals: AdminAiUsageTotalsResponse,
    val actualUsd: String?,
    val actualConfigured: Boolean,
    val actualFetchedAt: String?,
    val krwPerUsd: String?,
    val byFeature: List<AdminAiUsageGroupResponse>,
    val byModel: List<AdminAiUsageGroupResponse>,
    val days: List<AdminAiCostDayResponse>,
    val topAccounts: List<AdminAiUsageAccountResponse>,
    val comparison: AdminAiCostComparisonResponse?,
) {
    companion object {
        fun from(summary: AiCostSummary) = AdminAiCostSummaryResponse(
            from = summary.from.toString(),
            to = summary.to.toString(),
            totals = AdminAiUsageTotalsResponse.from(summary.totals),
            actualUsd = summary.actualUsd?.usd(),
            actualConfigured = summary.actualConfigured,
            actualFetchedAt = summary.actualFetchedAt?.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
            krwPerUsd = summary.krwPerUsd?.toPlainString(),
            byFeature = summary.byFeature.map(AdminAiUsageGroupResponse::from),
            byModel = summary.byModel.map(AdminAiUsageGroupResponse::from),
            days = summary.days.map { AdminAiCostDayResponse(it.date.toString(), it.estimatedUsd.usd(), it.calls, it.actualUsd?.usd()) },
            topAccounts = summary.topAccounts.map {
                AdminAiUsageAccountResponse(it.accountId, it.email, it.planCode, AdminAiUsageTotalsResponse.from(it.totals))
            },
            comparison = summary.comparison?.let(AdminAiCostComparisonResponse::from),
        )
    }
}

data class AdminAiModelPriceResponse(
    val id: Long,
    val modelPrefix: String,
    val serviceTier: String,
    val inputUsdPerMillion: String,
    val cachedInputUsdPerMillion: String?,
    val outputUsdPerMillion: String,
    val effectiveFrom: String,
    val note: String?,
    val cacheWriteInputUsdPerMillion: String?,
    val cacheWrite12hInputUsdPerMillion: String?,
) {
    companion object {
        fun from(price: AiModelPrice) = AdminAiModelPriceResponse(
            price.id, price.modelPrefix, price.serviceTier, price.inputUsdPerMillion.stripTrailingZeros().toPlainString(),
            price.cachedInputUsdPerMillion?.stripTrailingZeros()?.toPlainString(), price.outputUsdPerMillion.stripTrailingZeros().toPlainString(),
            price.effectiveFrom.toString(), price.note,
            price.cacheWriteInputUsdPerMillion?.stripTrailingZeros()?.toPlainString(), price.cacheWrite12hInputUsdPerMillion?.stripTrailingZeros()?.toPlainString(),
        )
    }
}

data class AdminAiModelPriceRequest(
    @field:NotBlank @field:Size(max = 100) val modelPrefix: String,
    @field:NotBlank val serviceTier: String,
    @field:NotNull @field:DecimalMin("0") val inputUsdPerMillion: BigDecimal?,
    @field:DecimalMin("0") val cachedInputUsdPerMillion: BigDecimal? = null,
    @field:NotNull @field:DecimalMin("0") val outputUsdPerMillion: BigDecimal?,
    @field:NotNull val effectiveFrom: LocalDate?,
    @field:Size(max = 200) val note: String? = null,
    @field:DecimalMin("0") val cacheWriteInputUsdPerMillion: BigDecimal? = null,
    @field:DecimalMin("0") val cacheWrite12hInputUsdPerMillion: BigDecimal? = null,
) {
    fun toDomain() = NewAiModelPrice(
        modelPrefix.trim(), serviceTier.trim(), requireNotNull(inputUsdPerMillion), cachedInputUsdPerMillion, requireNotNull(outputUsdPerMillion),
        requireNotNull(effectiveFrom), note?.trim()?.takeIf { it.isNotEmpty() },
        cacheWriteInputUsdPerMillion, cacheWrite12hInputUsdPerMillion,
    )
}

data class AdminAiCostSyncResponse(val from: String, val to: String, val lines: Int, val amountUsd: String) {
    companion object {
        fun from(result: AiCostSyncResult) = AdminAiCostSyncResponse(result.from.toString(), result.to.toString(), result.lines, result.amountUsd.usd())
    }
}
