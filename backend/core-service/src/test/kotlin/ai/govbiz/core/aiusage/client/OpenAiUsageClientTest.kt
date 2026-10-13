package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException.Reason
import ai.govbiz.core.aiusage.config.AiCostProperties
import java.time.LocalDate
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.startsWith
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.queryParam
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import org.springframework.web.util.UriComponentsBuilder

class OpenAiUsageClientTest {
    private val builder = RestClient.builder().baseUrl("https://api.openai.test")
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val properties = AiCostProperties(openaiAdminKey = "admin-key", openaiProjectId = "proj_govbiz")
    private val client = OpenAiUsageClient(builder.build(), properties)
    private val from = LocalDate.of(2026, 10, 9)
    private val to = from.plusDays(2)
    private val firstDay = 1791504000L
    private val secondDay = firstDay + 86400

    @Test
    fun readsBothEndpointsWithAllPagesAndIdenticalUtcRangeIncludingEmptyDays() {
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/usage/completions")))
            .andExpect(queryParam("start_time", firstDay.toString()))
            .andExpect(queryParam("end_time", (firstDay + 172800).toString()))
            .andExpect(queryParam("bucket_width", "1d"))
            .andExpect(queryParam("limit", "31"))
            .andExpect(queryParam("group_by", "project_id", "model", "service_tier", "batch"))
            .andExpect(queryParam("project_ids", "proj_govbiz"))
            .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer admin-key"))
            .andRespond(withSuccess(page(listOf(bucket(firstDay, completion())), "completion-next"), MediaType.APPLICATION_JSON))
        server.expect(requestTo(containsString("page=completion-next")))
            .andRespond(withSuccess(page(listOf(bucket(secondDay, ""))), MediaType.APPLICATION_JSON))
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/usage/embeddings")))
            .andExpect(queryParam("start_time", firstDay.toString()))
            .andExpect(queryParam("end_time", (firstDay + 172800).toString()))
            .andExpect(queryParam("group_by", "project_id", "model"))
            .andExpect(queryParam("project_ids", "proj_govbiz"))
            .andRespond(withSuccess(page(listOf(bucket(firstDay, "")), "embedding-next"), MediaType.APPLICATION_JSON))
        server.expect(requestTo(containsString("page=embedding-next")))
            .andRespond(withSuccess(page(listOf(bucket(secondDay, embedding()))), MediaType.APPLICATION_JSON))

        val result = client.fetch(from, to)
        assertEquals(from, result.from)
        assertEquals(to, result.toExclusive)
        assertEquals(setOf(from, from.plusDays(1)), result.coveredDates)
        assertEquals(2, result.lines.size)
        val completion = result.lines[0]
        assertEquals(100L, completion.inputTokens)
        assertEquals(10L, completion.cachedInputTokens)
        assertEquals(40L, completion.cacheWriteTokens)
        assertEquals(20L, completion.cacheWrite12hTokens)
        assertEquals(15L, completion.outputTokens)
        assertEquals(false, completion.batch)
        val embedding = result.lines[1]
        assertEquals("embeddings", embedding.usageKind)
        assertEquals(from.plusDays(1), embedding.date)
        assertEquals(80L, embedding.inputTokens)
        assertEquals(0L, embedding.outputTokens)
        assertEquals(0L, embedding.cacheWriteTokens)
        assertEquals(0L, embedding.cacheWrite12hTokens)
        assertNull(embedding.batch)
        server.verify()
    }

    @Test
    fun zeroUsageStillHasCompleteCoverageAndMissingOptionalCountersRemainUnknown() {
        val result = completion().replace(",\"input_cached_tokens\":10,\"input_cache_write_tokens\":40,\"input_cache_write_12h_tokens\":20", "")
            .replace("\"service_tier\":\"default\",\"batch\":false,", "")
        expectCompletions(page(listOf(bucket(firstDay, result), bucket(secondDay, ""))))
        expectEmbeddings(emptyDays())
        val line = client.fetch(from, to).lines.single()
        assertNull(line.cachedInputTokens)
        assertNull(line.cacheWriteTokens)
        assertNull(line.cacheWrite12hTokens)
        assertNull(line.batch)
        assertEquals("unknown", line.serviceTier)
        server.verify()
        server.reset()
        expectCompletions(emptyDays())
        expectEmbeddings(emptyDays())
        val empty = client.fetch(from, to)
        assertEquals(emptyList<Any>(), empty.lines)
        assertEquals(setOf(from, from.plusDays(1)), empty.coveredDates)
        server.verify()
    }

    @Test
    fun preservesFastTierAndSeparatesBatchFromRegularUsage() {
        val fast = completion().replace("\"default\"", "\"fast-tier\"")
        val batch = fast.replace("\"batch\":false", "\"batch\":true")
        expectCompletions(page(listOf(bucket(firstDay, "$fast,$batch"), bucket(secondDay, ""))))
        expectEmbeddings(emptyDays())
        val lines = client.fetch(from, to).lines
        assertEquals(listOf("fast-tier", "fast-tier"), lines.map { it.serviceTier })
        assertEquals(listOf(false, true), lines.map { it.batch })
        server.verify()
    }

    @Test
    fun unfilteredOrganizationUsageKeepsProjectsSeparateAndUnknownProjectIdentity() {
        val unfiltered = OpenAiUsageClient(builder.build(), AiCostProperties(openaiAdminKey = "admin-key"))
        val unknownProject = completion().replace("\"project_id\":\"proj_govbiz\"", "\"project_id\":null")
        val otherProject = completion().replace("proj_govbiz", "proj_other")
        server.expect(requestTo(containsString("/usage/completions")))
            .andExpect { request -> assertNull(UriComponentsBuilder.fromUri(request.uri).build().queryParams["project_ids"]) }
            .andRespond(withSuccess(page(listOf(bucket(firstDay, "$unknownProject,$otherProject"), bucket(secondDay, ""))), MediaType.APPLICATION_JSON))
        server.expect(requestTo(containsString("/usage/embeddings")))
            .andExpect { request -> assertNull(UriComponentsBuilder.fromUri(request.uri).build().queryParams["project_ids"]) }
            .andRespond(withSuccess(emptyDays(), MediaType.APPLICATION_JSON))
        assertEquals(listOf("", "proj_other"), unfiltered.fetch(from, to).lines.map { it.projectId })
        server.verify()
    }

    @Test
    fun aLaterEndpointFailureDiscardsTheEarlierSuccessfulResult() {
        expectCompletions(page(listOf(bucket(firstDay, completion()), bucket(secondDay, ""))))
        server.expect(requestTo(containsString("/usage/embeddings"))).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
        assertReason(Reason.UNAVAILABLE)
        server.verify()
    }

    @Test
    fun credentialsAndMalformedResponsesProduceStableErrorsWithoutResponseBody() {
        for (status in listOf(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)) {
            server.expect(requestTo(containsString("/usage/completions"))).andRespond(withStatus(status).body("secret-body"))
            val error = assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }
            assertEquals(Reason.REJECTED, error.reason)
            assertEquals("REJECTED", error.message)
            assertNull(error.cause)
            server.verify()
            server.reset()
        }
        expectCompletions("{not json}")
        assertReason(Reason.INVALID_RESPONSE)
    }

    @Test
    fun rejectsMalformedTokensProjectScopeAndWrongResultTypes() {
        val valid = completion()
        val invalid = listOf(
            valid.replace("\"input_tokens\":100", "\"input_tokens\":-1"),
            valid.replace("\"num_model_requests\":2", "\"num_model_requests\":1.5"),
            valid.replace("\"input_tokens\":100", "\"input_tokens\":9223372036854775808"),
            valid.replace("\"num_model_requests\":2", "\"num_model_requests\":0"),
            valid.replace("\"input_cache_write_tokens\":40", "\"input_cache_write_tokens\":80"),
            valid.replace("\"input_cache_write_12h_tokens\":20", "\"input_cache_write_12h_tokens\":-1"),
            valid.replace("\"input_tokens\":100,", ""),
            valid.replace("\"output_tokens\":15", "\"output_tokens\":null"),
            valid.replace("proj_govbiz", "proj_other"),
            valid.replace("\"project_id\":\"proj_govbiz\"", "\"project_id\":null"),
            valid.replace("\"model\":\"gpt-6-luna\"", "\"model\":null"),
            valid.replace("organization.usage.completions.result", "organization.usage.embeddings.result"),
        )
        for (row in invalid) {
            expectCompletions(page(listOf(bucket(firstDay, row), bucket(secondDay, ""))))
            assertReason(Reason.INVALID_RESPONSE)
            server.verify()
            server.reset()
        }
    }

    @Test
    fun rejectsIncompleteDuplicateOrNonUtcDailyBuckets() {
        val invalid = listOf(
            page(listOf(bucket(firstDay, completion()))),
            page(listOf(bucket(firstDay, completion()), bucket(firstDay, ""))),
            page(listOf(bucket(firstDay + 1, completion()), bucket(secondDay, ""))),
            page(listOf(bucket(firstDay, completion(), firstDay + 3600), bucket(secondDay, ""))),
            page(listOf(bucket(firstDay, completion()), bucket(secondDay + 86400, ""))),
            page(listOf(bucket(firstDay, "${completion()},${completion()}"), bucket(secondDay, ""))),
            emptyDays().replace("\"results\":[]", "\"results\":null"),
            "{\"data\":null,\"has_more\":false}",
        )
        for (body in invalid) {
            expectCompletions(body)
            assertReason(Reason.INVALID_RESPONSE)
            server.verify()
            server.reset()
        }
    }

    @Test
    fun rejectsContradictoryMissingAndRepeatingPaginationCursors() {
        for (body in listOf(
            emptyDays().replace("\"has_more\":false", "\"has_more\":true"),
            emptyDays().replace("\"has_more\":false", "\"has_more\":null"),
            emptyDays().replace("\"next_page\":null", "\"next_page\":\"unexpected\""),
        )) {
            expectCompletions(body)
            assertReason(Reason.INVALID_RESPONSE)
            server.verify()
            server.reset()
        }
        expectCompletions(page(listOf(bucket(firstDay, completion())), "loop"))
        server.expect(requestTo(containsString("page=loop")))
            .andRespond(withSuccess(page(listOf(bucket(secondDay, "")), "loop"), MediaType.APPLICATION_JSON))
        assertReason(Reason.INVALID_RESPONSE)
        server.verify()
    }

    @Test
    fun invalidRequestRangeMakesNoApiCall() {
        assertThrows(IllegalArgumentException::class.java) { client.fetch(from, from) }
        assertThrows(IllegalArgumentException::class.java) { client.fetch(from, from.plusDays(181)) }
        server.verify()
    }

    private fun assertReason(reason: Reason) = assertEquals(
        reason,
        assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason,
    )

    private fun expectCompletions(body: String) {
        server.expect(requestTo(containsString("/usage/completions"))).andRespond(withSuccess(body, MediaType.APPLICATION_JSON))
    }

    private fun expectEmbeddings(body: String) {
        server.expect(requestTo(containsString("/usage/embeddings"))).andRespond(withSuccess(body, MediaType.APPLICATION_JSON))
    }

    private fun emptyDays() = page(listOf(bucket(firstDay, ""), bucket(secondDay, "")))

    private fun page(buckets: List<String>, next: String? = null) =
        """{"data":[${buckets.joinToString(",")}],"has_more":${next != null},"next_page":${next?.let { "\"$it\"" } ?: "null"}}"""

    private fun bucket(start: Long, rows: String, end: Long = start + 86400) =
        """{"start_time":$start,"end_time":$end,"results":[$rows]}"""

    private fun completion() = """{"object":"organization.usage.completions.result","project_id":"proj_govbiz","model":"gpt-6-luna","service_tier":"default","batch":false,"num_model_requests":2,"input_tokens":100,"input_cached_tokens":10,"input_cache_write_tokens":40,"input_cache_write_12h_tokens":20,"output_tokens":15}"""

    private fun embedding() = """{"object":"organization.usage.embeddings.result","project_id":"proj_govbiz","model":"text-embedding-3-small","num_model_requests":1,"input_tokens":80}"""
}
