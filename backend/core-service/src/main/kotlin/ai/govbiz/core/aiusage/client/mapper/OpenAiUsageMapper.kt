package ai.govbiz.core.aiusage.client.mapper

import ai.govbiz.core.aiusage.client.dto.OpenAiUsageResultPayload
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.domain.OpenAiUsageLine
import java.math.BigDecimal
import java.time.LocalDate

/** 그룹별 공급자 사용량을 검증합니다. 공급자가 주지 않은 캐시 계수는 0으로 만들지 않습니다. */
object OpenAiUsageMapper {
    fun toLine(result: OpenAiUsageResultPayload, date: LocalDate, usageKind: String, projectFilter: String): OpenAiUsageLine {
        if (result.objectType != "organization.usage.$usageKind.result") invalid()
        val project = result.projectId.orEmpty()
        if (project.length > 100 || project.any { it.code !in 33..126 } || (projectFilter.isNotBlank() && project != projectFilter)) invalid()
        val model = result.model?.takeIf { AiModelUsage.MODEL.matches(it) } ?: invalid()
        val embeddings = usageKind == "embeddings"
        val tier = if (embeddings) "default" else result.serviceTier ?: "unknown"
        if (!Regex("^[a-z][a-z0-9_-]{0,19}$").matches(tier)) invalid()
        val calls = count(result.calls ?: invalid())
        val input = count(result.inputTokens ?: invalid())
        val output = if (embeddings) 0 else count(result.outputTokens ?: invalid())
        val cached = if (embeddings) 0 else result.cachedInputTokens?.let(::count)
        val write = if (embeddings) 0 else result.cacheWriteTokens?.let(::count)
        val write12h = if (embeddings) 0 else result.cacheWrite12hTokens?.let(::count)
        var remaining = input
        for (part in listOfNotNull(cached, write, write12h)) {
            if (part > remaining) invalid()
            remaining -= part
        }
        if (calls == 0L && (input != 0L || output != 0L)) invalid()
        return OpenAiUsageLine(date, usageKind, project, model, tier, calls, input, cached, write, write12h, output, if (embeddings) null else result.batch)
    }

    fun count(value: BigDecimal): Long = try {
        value.longValueExact().also { if (it < 0) invalid() }
    } catch (_: ArithmeticException) {
        invalid()
    }

    private fun invalid(): Nothing = throw OpenAiCostsClientException(OpenAiCostsClientException.Reason.INVALID_RESPONSE)
}
