package ai.govbiz.core.aiusage.domain

import java.time.LocalDate

/** OpenAI가 집계한 UTC 하루의 사용량입니다. 입력에는 캐시 읽기와 두 보존 기간의 캐시 쓰기가 포함됩니다. */
data class OpenAiUsageLine(
    val date: LocalDate,
    val usageKind: String,
    val projectId: String,
    val model: String,
    val serviceTier: String,
    val calls: Long,
    val inputTokens: Long,
    val cachedInputTokens: Long?,
    val cacheWriteTokens: Long?,
    val cacheWrite12hTokens: Long?,
    val outputTokens: Long,
    val batch: Boolean? = null,
)

/** 두 Usage API가 모두 성공한 범위입니다. 사용량이 없는 날도 [coveredDates]에 포함됩니다. */
data class OpenAiUsageSnapshot(
    val from: LocalDate,
    val toExclusive: LocalDate,
    val lines: List<OpenAiUsageLine>,
    val coveredDates: Set<LocalDate>,
)
