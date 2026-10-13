package ai.govbiz.core.aiusage.client.dto

import com.fasterxml.jackson.annotation.JsonProperty
import java.math.BigDecimal

/** 조직 Usage API의 하루 집계 응답입니다. 정수 필드는 변환 시 소수·범위 초과를 거절합니다. */
data class OpenAiUsagePagePayload(
    val data: List<OpenAiUsageBucketPayload>? = null,
    @param:JsonProperty("has_more") val hasMore: Boolean? = null,
    @param:JsonProperty("next_page") val nextPage: String? = null,
)

data class OpenAiUsageBucketPayload(
    @param:JsonProperty("start_time") val startTime: BigDecimal? = null,
    @param:JsonProperty("end_time") val endTime: BigDecimal? = null,
    val results: List<OpenAiUsageResultPayload>? = null,
)

data class OpenAiUsageResultPayload(
    @param:JsonProperty("object") val objectType: String? = null,
    @param:JsonProperty("project_id") val projectId: String? = null,
    val model: String? = null,
    @param:JsonProperty("service_tier") val serviceTier: String? = null,
    val batch: Boolean? = null,
    @param:JsonProperty("num_model_requests") val calls: BigDecimal? = null,
    @param:JsonProperty("input_tokens") val inputTokens: BigDecimal? = null,
    @param:JsonProperty("input_cached_tokens") val cachedInputTokens: BigDecimal? = null,
    @param:JsonProperty("input_cache_write_tokens") val cacheWriteTokens: BigDecimal? = null,
    @param:JsonProperty("input_cache_write_12h_tokens") val cacheWrite12hTokens: BigDecimal? = null,
    @param:JsonProperty("output_tokens") val outputTokens: BigDecimal? = null,
)
