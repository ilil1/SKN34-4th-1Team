package ai.govbiz.core.aiusage.domain

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.LocalDateTime

/** AI 비용을 나눠 보는 기능입니다. 요금제 한도 기능 넷과 도우미·리포트·관심 공고 준비이며, 없으면 로그인 전 요청이나 시스템 작업입니다. */
enum class AiUsageFeature {
    AI_SEARCH,
    EVIDENCE_QUESTION,
    APPLICATION_DRAFT,
    COMBINATION_REVIEW,
    ASSISTANT,
    DAILY_REPORT,
    SAVED_PROGRAM_PREFETCH,
    /** 관리자 Gov 에이전트의 경로 선택과 그 안의 검색 조건 해석입니다. 원문 답변은 EVIDENCE_QUESTION으로 셉니다. */
    GOV_AGENT,
}

/** 지금 AI를 부르는 계정과 기능입니다. 계정이 없으면 로그인 전 요청이나 시스템 작업입니다. */
data class AiUsageAttribution(val accountId: Long?, val feature: AiUsageFeature)

/** ai-service 요청 하나가 쓴 (모델, 처리 등급)별 OpenAI 사용량입니다. 입력은 캐시 토큰을, 출력은 추론 토큰을 포함합니다. */
data class AiModelUsage(
    val model: String,
    val serviceTier: String,
    val calls: Int,
    val inputTokens: Long,
    val cachedInputTokens: Long,
    val outputTokens: Long,
    val cacheWriteInputTokens: Long? = null,
    val cacheWrite12hInputTokens: Long? = null,
) {
    init {
        require(MODEL.matches(model)) { "model must be an OpenAI model name" }
        require(TIER.matches(serviceTier)) { "serviceTier must be a lowercase word" }
        require(calls >= 1) { "calls must be positive" }
        require(inputTokens >= 0 && outputTokens >= 0 && cachedInputTokens in 0..inputTokens) { "token counts are invalid" }
        require(cacheWriteInputTokens == null || cacheWriteInputTokens in 0..(inputTokens - cachedInputTokens)) { "cache write tokens are invalid" }
        require(cacheWrite12hInputTokens == null || cacheWrite12hInputTokens in 0..(inputTokens - cachedInputTokens - (cacheWriteInputTokens ?: 0))) {
            "12h cache write tokens are invalid"
        }
    }

    companion object {
        val MODEL = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
        val TIER = Regex("^[a-z]{1,20}$")
    }
}

/**
 * 1M 토큰당 USD 가격입니다. [modelPrefix]는 스냅숏 이름(`gpt-5.6-luna-2026-07-30`)까지 맞추고, 캐시 입력 가격이 없으면 입력 가격을 씁니다.
 * 같은 모델·등급에 가격이 여럿이면 더 긴 접두어, 그다음 사용일 기준으로 가장 늦게 시작한 가격을 씁니다.
 */
data class AiModelPrice(
    val id: Long,
    val modelPrefix: String,
    val serviceTier: String,
    val inputUsdPerMillion: BigDecimal,
    val cachedInputUsdPerMillion: BigDecimal?,
    val outputUsdPerMillion: BigDecimal,
    val effectiveFrom: LocalDate,
    val note: String?,
    val cacheWriteInputUsdPerMillion: BigDecimal? = null,
    val cacheWrite12hInputUsdPerMillion: BigDecimal? = null,
) {
    fun covers(model: String, tier: String): Boolean =
        serviceTier == tier && (model == modelPrefix || model.startsWith("$modelPrefix-"))

    fun costUsd(usage: AiModelUsage): BigDecimal? = costUsd(
        usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.cacheWriteInputTokens, usage.cacheWrite12hInputTokens,
    )

    fun costUsd(inputTokens: Long, cachedInputTokens: Long?, outputTokens: Long, cacheWriteInputTokens: Long?, cacheWrite12hInputTokens: Long?): BigDecimal? {
        // 미보고 사용량·미등록 쓰기 가격은 0원으로 추정하지 않습니다.
        val reads = cachedInputTokens ?: return null
        val writes = cacheWriteInputTokens ?: return null
        val writes12h = cacheWrite12hInputTokens ?: return null
        require(inputTokens >= 0 && outputTokens >= 0 && reads in 0..inputTokens && writes in 0..(inputTokens - reads) &&
            writes12h in 0..(inputTokens - reads - writes)) { "token counts are invalid" }
        if (writes > 0 && cacheWriteInputUsdPerMillion == null) return null
        if (writes12h > 0 && cacheWrite12hInputUsdPerMillion == null) return null
        val cached = BigDecimal.valueOf(reads)
        val uncached = BigDecimal.valueOf(inputTokens - reads - writes - writes12h)
        val output = BigDecimal.valueOf(outputTokens)
        val total = uncached * inputUsdPerMillion + cached * (cachedInputUsdPerMillion ?: inputUsdPerMillion) + output * outputUsdPerMillion +
            BigDecimal.valueOf(writes) * (cacheWriteInputUsdPerMillion ?: BigDecimal.ZERO) +
            BigDecimal.valueOf(writes12h) * (cacheWrite12hInputUsdPerMillion ?: BigDecimal.ZERO)
        return total.divide(MILLION, COST_SCALE, RoundingMode.HALF_UP)
    }

    companion object {
        const val COST_SCALE = 10
        val TIERS = setOf("default", "priority", "flex")
        private val MILLION = BigDecimal(1_000_000)

        fun find(prices: List<AiModelPrice>, model: String, tier: String, on: LocalDate): AiModelPrice? =
            prices.filter { it.covers(model, tier) && !it.effectiveFrom.isAfter(on) }
                .maxWithOrNull(compareBy<AiModelPrice>({ it.modelPrefix.length }, { it.effectiveFrom }))
    }
}

/** 관리자가 더하는 새 가격입니다. 기존 가격은 고치지 않고 시작일이 다른 행을 더합니다. */
data class NewAiModelPrice(
    val modelPrefix: String,
    val serviceTier: String,
    val inputUsdPerMillion: BigDecimal,
    val cachedInputUsdPerMillion: BigDecimal?,
    val outputUsdPerMillion: BigDecimal,
    val effectiveFrom: LocalDate,
    val note: String?,
    val cacheWriteInputUsdPerMillion: BigDecimal? = null,
    val cacheWrite12hInputUsdPerMillion: BigDecimal? = null,
) {
    init {
        require(PREFIX.matches(modelPrefix)) { "modelPrefix must be a lowercase OpenAI model name" }
        require(serviceTier in AiModelPrice.TIERS) { "serviceTier must be default, priority or flex" }
        require(listOfNotNull(inputUsdPerMillion, cachedInputUsdPerMillion, outputUsdPerMillion, cacheWriteInputUsdPerMillion, cacheWrite12hInputUsdPerMillion).all { it.signum() >= 0 && it < LIMIT }) {
            "prices must be between 0 and 1,000,000"
        }
        require(note == null || note.length <= 200) { "note must be at most 200 characters" }
    }

    private companion object {
        val PREFIX = Regex("^[a-z0-9][a-z0-9._:-]{0,99}$")
        val LIMIT = BigDecimal(1_000_000)
    }
}

/** 기간 합계입니다. [unpricedCalls]는 가격·사용량 미확정으로 추정 비용 합계에서 제외한 호출 수입니다. */
data class AiUsageTotals(
    val calls: Long,
    val inputTokens: Long,
    val cachedInputTokens: Long,
    val outputTokens: Long,
    val estimatedUsd: BigDecimal,
    val unpricedCalls: Long,
    val cacheWriteInputTokens: Long? = null,
    val cacheWrite12hInputTokens: Long? = null,
    val incompleteUsageCalls: Long = 0,
) {
    companion object {
        val EMPTY = AiUsageTotals(0, 0, 0, 0, BigDecimal.ZERO, 0, 0, 0)
    }
}

/** 기능 또는 (모델, 처리 등급)별 합계입니다. 기능이 없는 행은 [key]가 null입니다. */
data class AiUsageGroup(val key: String?, val serviceTier: String?, val totals: AiUsageTotals)

/** UTC 날짜별 앱 기록입니다. 실제 비용 비교는 [AiCostComparison]을 사용합니다. */
data class AiCostDay(val date: LocalDate, val estimatedUsd: BigDecimal, val calls: Long, val actualUsd: BigDecimal?)

data class AiUsageAccount(val accountId: Long, val email: String, val planCode: String?, val totals: AiUsageTotals)

/** OpenAI Costs API가 알려 준 하루(UTC)·프로젝트·항목별 실제 비용입니다. */
data class OpenAiCostLine(val date: LocalDate, val projectId: String, val lineItem: String, val amountUsd: BigDecimal)

/**
 * 관리자 AI 비용 화면의 UTC 기간입니다. 앱 기록과 조직 비교는 범위가 달라 comparison만 비용 대조에 사용합니다.
 * 관리자 키가 없거나 아직 가져오지 않았으면 [actualUsd]가 null입니다.
 */
data class AiCostSummary(
    val from: LocalDate,
    val to: LocalDate,
    val totals: AiUsageTotals,
    val actualUsd: BigDecimal?,
    val actualConfigured: Boolean,
    val actualFetchedAt: LocalDateTime?,
    val krwPerUsd: BigDecimal?,
    val byFeature: List<AiUsageGroup>,
    val byModel: List<AiUsageGroup>,
    val days: List<AiCostDay>,
    val topAccounts: List<AiUsageAccount>,
    val comparison: AiCostComparison? = null,
)

/** 같은 UTC 구간·동기화에서 받은 조직 사용량과 비용입니다. ready도 최종 청구 확정을 뜻하지 않습니다. */
data class AiCostComparison(
    val from: LocalDate,
    val to: LocalDate,
    val fetchedAt: LocalDateTime?, // UTC
    val status: String,
    val includesCurrentDay: Boolean,
    val totals: AiUsageTotals?,
    val actualUsd: BigDecimal?,
    val days: List<AiCostComparisonDay>,
)

data class AiCostComparisonDay(val date: LocalDate, val totals: AiUsageTotals, val actualUsd: BigDecimal?)

/** 실제 비용을 가져온 결과입니다. */
data class AiCostSyncResult(val from: LocalDate, val to: LocalDate, val lines: Int, val amountUsd: BigDecimal)
