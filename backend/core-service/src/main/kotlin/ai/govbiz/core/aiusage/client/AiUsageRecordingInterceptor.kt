package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.client.dto.AiServiceUsagePayload
import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.helper.AiUsageContextHelper
import ai.govbiz.core.aiusage.service.AiUsageService
import org.slf4j.LoggerFactory
import org.springframework.http.HttpRequest
import org.springframework.http.client.ClientHttpRequestExecution
import org.springframework.http.client.ClientHttpRequestInterceptor
import org.springframework.http.client.ClientHttpResponse
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

/**
 * ai-service 응답의 OpenAI 사용량 헤더를 읽어 지금 계정·기능([AiUsageContextHelper])과 함께 기록합니다. 실패 응답도 그 전에 쓴 토큰이
 * 있으면 헤더가 오므로 기록합니다. 기록하지 못해도 사용자의 요청은 그대로 진행하고 경고만 남깁니다.
 */
@Component
class AiUsageRecordingInterceptor(
    private val service: AiUsageService,
    private val json: ObjectMapper,
) : ClientHttpRequestInterceptor {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun intercept(request: HttpRequest, body: ByteArray, execution: ClientHttpRequestExecution): ClientHttpResponse {
        val response = execution.execute(request, body)
        val header = response.headers.getFirst(USAGE_HEADER) ?: return response
        val operation = operationOf(request.uri.path)
        try {
            val usages = json.readValue(header, Array<AiServiceUsagePayload>::class.java).map {
                AiModelUsage(it.model, it.serviceTier, it.calls, it.inputTokens, it.cachedInputTokens, it.outputTokens,
                    it.cacheWriteInputTokens, it.cacheWrite12hInputTokens)
            }
            service.record(operation, usages, AiUsageContextHelper.current())
        } catch (error: Exception) {
            log.warn("ai_usage_not_recorded operation={} error={}", operation, error.javaClass.simpleName)
        }
        return response
    }

    companion object {
        const val USAGE_HEADER = "X-GovBiz-OpenAI-Usage"
        private const val INTERNAL_PREFIX = "/internal/v1/"

        /** `/internal/v1/support-program-rankings/rank` → `support-program-rankings/rank` */
        fun operationOf(path: String): String = path.removePrefix(INTERNAL_PREFIX).take(80).ifBlank { "unknown" }
    }
}
