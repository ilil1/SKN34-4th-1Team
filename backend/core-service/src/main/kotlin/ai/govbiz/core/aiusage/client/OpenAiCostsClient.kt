package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.client.dto.OpenAiCostsPagePayload
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException.Reason
import ai.govbiz.core.aiusage.client.mapper.OpenAiCostsMapper
import ai.govbiz.core.aiusage.config.AiCostProperties
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.web.client.RestClientException
import org.springframework.web.client.RestClientResponseException

/**
 * OpenAI 조직 Costs API에서 하루(UTC) 단위 실제 비용을 프로젝트·항목별로 모두 가져옵니다. 관리자 키로만 부를 수 있고,
 * 다음 쪽 커서를 따라 끝까지 읽은 뒤에만 돌려줍니다. 한 쪽이라도 실패하면 아무것도 돌려주지 않습니다.
 */
@Component
class OpenAiCostsClient(
    @param:Qualifier("openAiCostsRestClient") private val client: RestClient,
    private val properties: AiCostProperties,
) {
    fun fetch(from: LocalDate, toExclusive: LocalDate): List<OpenAiCostLine> {
        require(ChronoUnit.DAYS.between(from, toExclusive) in 1..180) { "cost range must be between 1 and 180 UTC days" }
        val dates = from.datesUntil(toExclusive).toList().toSet()
        val lines = mutableListOf<OpenAiCostLine>()
        val coveredDates = mutableSetOf<LocalDate>()
        val cursors = mutableSetOf<String>()
        var cursor: String? = null
        repeat(MAX_PAGES) {
            val page = call(from, toExclusive, cursor)
            lines += OpenAiCostsMapper.toLines(page, from, toExclusive, properties.openaiProjectId)
            for (bucket in page.data ?: invalid()) {
                // Mapper가 UTC 하루 경계를 확인했다. 결과가 없는 날짜도 완전성 검증에 포함한다.
                val date = Instant.ofEpochSecond(bucket.startTime ?: invalid()).atOffset(ZoneOffset.UTC).toLocalDate()
                if (!coveredDates.add(date)) invalid()
            }
            val next = page.nextPage
            when (page.hasMore) {
                false -> {
                    if (next != null || coveredDates != dates) invalid()
                    return lines
                }
                true -> {
                    if (next.isNullOrBlank() || next.length > MAX_CURSOR_LENGTH || next.any { it.isISOControl() } || !cursors.add(next)) invalid()
                    cursor = next
                }
                null -> invalid()
            }
        }
        invalid()
    }

    private fun call(from: LocalDate, toExclusive: LocalDate, cursor: String?): OpenAiCostsPagePayload = try {
        client.get()
            .uri { builder ->
                builder.path("/v1/organization/costs")
                    .queryParam("start_time", from.atStartOfDay().toEpochSecond(ZoneOffset.UTC))
                    .queryParam("end_time", toExclusive.atStartOfDay().toEpochSecond(ZoneOffset.UTC))
                    .queryParam("bucket_width", "1d")
                    .queryParam("group_by", "project_id")
                    .queryParam("group_by", "line_item")
                    .queryParam("limit", PAGE_LIMIT)
                properties.openaiProjectId.takeIf { it.isNotBlank() }?.let { builder.queryParam("project_ids", it) }
                cursor?.let { builder.queryParam("page", it) }
                builder.build()
            }
            .header(HttpHeaders.AUTHORIZATION, "Bearer ${properties.openaiAdminKey}")
            .retrieve()
            .body(OpenAiCostsPagePayload::class.java)
            ?: throw OpenAiCostsClientException(Reason.INVALID_RESPONSE)
    } catch (error: OpenAiCostsClientException) {
        throw error
    } catch (error: RestClientResponseException) {
        val status = error.statusCode.value()
        val reason = if (status == HttpStatus.UNAUTHORIZED.value() || status == HttpStatus.FORBIDDEN.value()) Reason.REJECTED else Reason.UNAVAILABLE
        throw OpenAiCostsClientException(reason)
    } catch (error: RestClientException) {
        val reason = if (error.cause is java.io.IOException) Reason.UNAVAILABLE else Reason.INVALID_RESPONSE
        throw OpenAiCostsClientException(reason)
    }

    private fun invalid(): Nothing = throw OpenAiCostsClientException(Reason.INVALID_RESPONSE)

    private companion object {
        const val PAGE_LIMIT = 180
        const val MAX_PAGES = 20
        const val MAX_CURSOR_LENGTH = 2048
    }
}
