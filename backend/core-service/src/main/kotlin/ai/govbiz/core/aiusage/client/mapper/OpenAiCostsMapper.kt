package ai.govbiz.core.aiusage.client.mapper

import ai.govbiz.core.aiusage.client.dto.OpenAiCostsPagePayload
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** Costs API 응답 한 쪽을 하루(UTC)·프로젝트·항목별 비용으로 바꿉니다. 요청 범위 밖이거나 USD가 아닌 값은 응답 전체를 믿지 않습니다. */
object OpenAiCostsMapper {
    fun toLines(page: OpenAiCostsPagePayload, from: LocalDate, toExclusive: LocalDate, projectFilter: String = ""): List<OpenAiCostLine> =
        (page.data ?: invalid()).flatMap { bucket ->
            val start = bucket.startTime ?: invalid()
            val end = bucket.endTime ?: invalid()
            val date = try { Instant.ofEpochSecond(start).atOffset(ZoneOffset.UTC).toLocalDate() } catch (_: RuntimeException) { invalid() }
            if (date.isBefore(from) || !date.isBefore(toExclusive) || start != date.atStartOfDay().toEpochSecond(ZoneOffset.UTC) || end != start + 86400) invalid()
            val lines = (bucket.results ?: invalid()).map { result ->
                val amount = result.amount ?: invalid()
                if (!amount.currency.equals("usd", ignoreCase = true)) invalid()
                val project = result.projectId.orEmpty()
                val lineItem = result.lineItem.orEmpty()
                if (project.length > 100 || project.any { it.code !in 33..126 } || (projectFilter.isNotBlank() && project != projectFilter)) invalid()
                if (lineItem.length > 200 || lineItem.any { it.isISOControl() }) invalid()
                OpenAiCostLine(
                    date = date,
                    projectId = project,
                    lineItem = lineItem,
                    amountUsd = amount.value ?: invalid(),
                )
            }
            if (lines.map { it.projectId to it.lineItem }.toSet().size != lines.size) invalid()
            lines
        }

    private fun invalid(): Nothing = throw OpenAiCostsClientException(OpenAiCostsClientException.Reason.INVALID_RESPONSE)
}
