package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.client.dto.OpenAiUsagePagePayload
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException.Reason
import ai.govbiz.core.aiusage.client.mapper.OpenAiUsageMapper
import ai.govbiz.core.aiusage.config.AiCostProperties
import ai.govbiz.core.aiusage.domain.OpenAiUsageLine
import ai.govbiz.core.aiusage.domain.OpenAiUsageSnapshot
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpHeaders
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.web.client.RestClientException
import org.springframework.web.client.RestClientResponseException

/** Core를 거치지 않은 호출도 포함한 조직 사용량을 읽습니다. 두 경로의 모든 하루·페이지가 성공해야 반환합니다. */
@Component
class OpenAiUsageClient(
    @param:Qualifier("openAiCostsRestClient") private val client: RestClient,
    private val properties: AiCostProperties,
) {
    fun fetch(from: LocalDate, toExclusive: LocalDate): OpenAiUsageSnapshot {
        require(ChronoUnit.DAYS.between(from, toExclusive) in 1..180) { "usage range must be between 1 and 180 UTC days" }
        val dates = from.datesUntil(toExclusive).toList().toSet()
        val lines = fetchKind("completions", from, toExclusive, dates) + fetchKind("embeddings", from, toExclusive, dates)
        return OpenAiUsageSnapshot(from, toExclusive, lines, dates)
    }

    private fun fetchKind(kind: String, from: LocalDate, toExclusive: LocalDate, dates: Set<LocalDate>): List<OpenAiUsageLine> {
        val lines = mutableListOf<OpenAiUsageLine>()
        val coveredDates = mutableSetOf<LocalDate>()
        val cursors = mutableSetOf<String>()
        var cursor: String? = null
        repeat(MAX_PAGES) {
            val page = call(kind, from, toExclusive, cursor)
            for (bucket in page.data ?: invalid()) {
                val start = OpenAiUsageMapper.count(bucket.startTime ?: invalid())
                val end = OpenAiUsageMapper.count(bucket.endTime ?: invalid())
                val date = try { Instant.ofEpochSecond(start).atOffset(ZoneOffset.UTC).toLocalDate() } catch (_: RuntimeException) { invalid() }
                if (date !in dates || start != date.atStartOfDay().toEpochSecond(ZoneOffset.UTC) || end != start + 86400 || !coveredDates.add(date)) invalid()
                val bucketLines = (bucket.results ?: invalid()).map { OpenAiUsageMapper.toLine(it, date, kind, properties.openaiProjectId) }
                if (bucketLines.map { listOf(it.projectId, it.model, it.serviceTier, it.batch) }.toSet().size != bucketLines.size) invalid()
                lines += bucketLines
            }
            val next = page.nextPage
            when (page.hasMore) {
                false -> {
                    if (next != null || coveredDates != dates) invalid()
                    return lines
                }
                true -> {
                    if (next.isNullOrBlank() || next.length > 2048 || next.any { it.isISOControl() } || !cursors.add(next)) invalid()
                    cursor = next
                }
                null -> invalid()
            }
        }
        invalid()
    }

    private fun call(kind: String, from: LocalDate, toExclusive: LocalDate, cursor: String?): OpenAiUsagePagePayload = try {
        client.get()
            .uri { builder ->
                builder.path("/v1/organization/usage/$kind")
                    .queryParam("start_time", from.atStartOfDay().toEpochSecond(ZoneOffset.UTC))
                    .queryParam("end_time", toExclusive.atStartOfDay().toEpochSecond(ZoneOffset.UTC))
                    .queryParam("bucket_width", "1d")
                    .queryParam("limit", PAGE_LIMIT)
                    .queryParam("group_by", "project_id")
                    .queryParam("group_by", "model")
                if (kind == "completions") builder.queryParam("group_by", "service_tier").queryParam("group_by", "batch")
                properties.openaiProjectId.takeIf { it.isNotBlank() }?.let { builder.queryParam("project_ids", it) }
                cursor?.let { builder.queryParam("page", it) }
                builder.build()
            }
            .header(HttpHeaders.AUTHORIZATION, "Bearer ${properties.openaiAdminKey}")
            .retrieve()
            .body(OpenAiUsagePagePayload::class.java) ?: invalid()
    } catch (error: OpenAiCostsClientException) {
        throw error
    } catch (error: RestClientResponseException) {
        throw OpenAiCostsClientException(if (error.statusCode.value() in listOf(401, 403)) Reason.REJECTED else Reason.UNAVAILABLE)
    } catch (error: RestClientException) {
        throw OpenAiCostsClientException(if (error.cause is java.io.IOException) Reason.UNAVAILABLE else Reason.INVALID_RESPONSE)
    }

    private fun invalid(): Nothing = throw OpenAiCostsClientException(Reason.INVALID_RESPONSE)

    private companion object {
        const val PAGE_LIMIT = 31
        const val MAX_PAGES = 20
    }
}
