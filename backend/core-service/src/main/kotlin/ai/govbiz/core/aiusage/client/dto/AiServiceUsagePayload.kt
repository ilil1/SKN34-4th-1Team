package ai.govbiz.core.aiusage.client.dto

/** ai-service가 `X-GovBiz-OpenAI-Usage` 헤더로 돌려주는 (모델, 처리 등급)별 사용량 한 줄입니다. */
data class AiServiceUsagePayload(
    val model: String,
    val serviceTier: String,
    val calls: Int,
    val inputTokens: Long,
    val cachedInputTokens: Long,
    val outputTokens: Long,
    val cacheWriteInputTokens: Long? = null,
    val cacheWrite12hInputTokens: Long? = null,
)
