package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.client.exception.OpenAiCostsClientException
import ai.govbiz.core.aiusage.config.AiCostProperties
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import java.math.BigDecimal
import java.time.LocalDate
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
import org.hamcrest.Matchers.containsString
import org.hamcrest.Matchers.startsWith

class OpenAiCostsClientTest {
    private val builder = RestClient.builder().baseUrl("https://api.openai.test")
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val properties = AiCostProperties(openaiAdminKey = "admin-key", openaiProjectId = "proj_govbiz")
    private val client = OpenAiCostsClient(builder.build(), properties)
    private val from = LocalDate.of(2026, 10, 9)
    private val to = LocalDate.of(2026, 10, 11)
    private val firstDay = 1791504000L
    private val secondDay = firstDay + 86400

    @Test
    fun readsEveryPageGroupedByProjectAndLineItemForOurProject() {
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/costs")))
            .andExpect(queryParam("start_time", "1791504000"))
            .andExpect(queryParam("end_time", "1791676800"))
            .andExpect(queryParam("bucket_width", "1d"))
            .andExpect(queryParam("limit", "180"))
            .andExpect(queryParam("group_by", "project_id", "line_item"))
            .andExpect(queryParam("project_ids", "proj_govbiz"))
            .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer admin-key"))
            .andRespond(withSuccess(page(1791504000, "0.0123", "next-1"), MediaType.APPLICATION_JSON))
        server.expect(requestTo(containsString("page=next-1")))
            .andRespond(withSuccess(page(1791590400, "1.5", null), MediaType.APPLICATION_JSON))

        assertEquals(
            listOf(
                OpenAiCostLine(from, "proj_govbiz", "gpt-5.6-luna, input", BigDecimal("0.0123")),
                OpenAiCostLine(from.plusDays(1), "proj_govbiz", "gpt-5.6-luna, input", BigDecimal("1.5")),
            ),
            client.fetch(from, to),
        )
        server.verify()
    }

    @Test
    fun aProjectKeyIsRejectedAndOtherFailuresAreUnavailable() {
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/costs"))).andRespond(withStatus(HttpStatus.FORBIDDEN))
        assertEquals(OpenAiCostsClientException.Reason.REJECTED, assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason)
        server.reset()
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/costs"))).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
        assertEquals(OpenAiCostsClientException.Reason.UNAVAILABLE, assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason)
    }

    @Test
    fun anotherCurrencyOrADayOutsideTheRangeIsNotTrusted() {
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/costs")))
            .andRespond(withSuccess(page(1791504000, "1", null, currency = "eur"), MediaType.APPLICATION_JSON))
        assertEquals(OpenAiCostsClientException.Reason.INVALID_RESPONSE, assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason)
        server.reset()
        server.expect(requestTo(startsWith("https://api.openai.test/v1/organization/costs")))
            .andRespond(withSuccess(page(1791676800, "1", null), MediaType.APPLICATION_JSON))
        assertEquals(OpenAiCostsClientException.Reason.INVALID_RESPONSE, assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason)
    }

    @Test
    fun emptyResultsMeanZeroOnlyAfterEveryRequestedDayIsPresent() {
        expectPage(emptyDays())

        assertEquals(emptyList<OpenAiCostLine>(), client.fetch(from, to))
        server.verify()
    }

    @Test
    fun negativeCreditsArePreservedAndNullProjectIsAllowedOnlyWithoutAFilter() {
        val unfiltered = OpenAiCostsClient(builder.build(), AiCostProperties(openaiAdminKey = "admin-key"))
        val credit = result("-0.25").replace("\"project_id\":\"proj_govbiz\"", "\"project_id\":null")
        val other = result("1.2").replace("proj_govbiz", "proj_other")
        server.expect(requestTo(containsString("/organization/costs")))
            .andExpect { request -> assertNull(UriComponentsBuilder.fromUri(request.uri).build().queryParams["project_ids"]) }
            .andRespond(withSuccess(pageOf(listOf(bucket(firstDay, "$credit,$other"), bucket(secondDay, ""))), MediaType.APPLICATION_JSON))

        val lines = unfiltered.fetch(from, to)
        assertEquals(listOf("", "proj_other"), lines.map { it.projectId })
        assertEquals(listOf(BigDecimal("-0.25"), BigDecimal("1.2")), lines.map { it.amountUsd })
        server.verify()
    }

    @Test
    fun missingAmountsResultsOrPageDataCannotBecomeZeroCost() {
        val row = result("1")
        val invalidRows = listOf(
            row.replace("\"value\":1", "\"value\":null"),
            row.replace("\"amount\":", "\"missing_amount\":"),
            row.replace("\"currency\":\"usd\"", "\"currency\":null"),
        )
        for (body in invalidRows.map { pageOf(listOf(bucket(firstDay, it), bucket(secondDay, ""))) } + listOf(
            emptyDays().replace("\"results\":[]", "\"results\":null"),
            emptyDays().replace("\"results\":[]", "\"missing_results\":[]"),
            "{\"data\":null,\"has_more\":false,\"next_page\":null}",
            "{\"has_more\":false,\"next_page\":null}",
            "null",
        )) {
            assertInvalidPage(body)
        }
    }

    @Test
    fun allBucketsMustBeUniqueCompleteUtcDaysWithinTheRequestedRange() {
        for (body in listOf(
            pageOf(emptyList()),
            pageOf(listOf(bucket(firstDay, ""))),
            pageOf(listOf(bucket(firstDay, ""), bucket(firstDay, ""))),
            pageOf(listOf(bucket(firstDay + 1, ""), bucket(secondDay, ""))),
            pageOf(listOf(bucket(firstDay, "", firstDay + 3600), bucket(secondDay, ""))),
            pageOf(listOf(bucket(firstDay, ""), bucket(secondDay + 86400, ""))),
            pageOf(listOf(bucket(Long.MAX_VALUE, "", Long.MAX_VALUE))),
            emptyDays().replace("\"end_time\":", "\"missing_end_time\":"),
        )) {
            assertInvalidPage(body)
        }
        expectPage(page(firstDay, "1", "next-page"))
        server.expect(requestTo(containsString("page=next-page")))
            .andRespond(withSuccess(page(firstDay, "2", null), MediaType.APPLICATION_JSON))
        assertInvalidResponse()
        server.verify()
    }

    @Test
    fun rejectsDuplicateGroupsUnexpectedProjectsAndIdentifiersThatWouldBeTruncated() {
        val row = result("1")
        for (rows in listOf(
            "$row,$row",
            row.replace("proj_govbiz", "proj_other"),
            row.replace("\"project_id\":\"proj_govbiz\"", "\"project_id\":null"),
            row.replace("proj_govbiz", "p".repeat(101)),
            row.replace("gpt-5.6-luna, input", "x".repeat(201)),
            row.replace("gpt-5.6-luna, input", "line\\nitem"),
        )) {
            assertInvalidPage(pageOf(listOf(bucket(firstDay, rows), bucket(secondDay, ""))))
        }
    }

    @Test
    fun paginationMustAgreeOnCompletionAndNeverRepeatACursor() {
        for (body in listOf(
            emptyDays().replace("\"has_more\":false", "\"has_more\":true"),
            emptyDays().replace("\"has_more\":false", "\"has_more\":null"),
            emptyDays().replace("\"has_more\":false,", ""),
            emptyDays().replace("\"next_page\":null", "\"next_page\":\"unexpected\""),
            page(firstDay, "1", " "),
            page(firstDay, "1", "x".repeat(2049)),
        )) {
            assertInvalidPage(body)
        }
        expectPage(page(firstDay, "1", "loop"))
        server.expect(requestTo(containsString("page=loop")))
            .andRespond(withSuccess(page(secondDay, "2", "loop"), MediaType.APPLICATION_JSON))
        assertInvalidResponse()
        server.verify()
    }

    @Test
    fun failureOnALaterPageDoesNotReturnAnEarlierPartialTotalOrProviderBody() {
        expectPage(page(firstDay, "1", "next-page"))
        server.expect(requestTo(containsString("page=next-page")))
            .andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE).body("private-provider-body"))

        val error = assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }
        assertEquals(OpenAiCostsClientException.Reason.UNAVAILABLE, error.reason)
        assertEquals("UNAVAILABLE", error.message)
        assertNull(error.cause)
        server.verify()
    }

    @Test
    fun invalidRequestRangesMakeNoExternalCall() {
        assertThrows(IllegalArgumentException::class.java) { client.fetch(from, from) }
        assertThrows(IllegalArgumentException::class.java) { client.fetch(from, from.minusDays(1)) }
        assertThrows(IllegalArgumentException::class.java) { client.fetch(from, from.plusDays(181)) }
        server.verify()
    }

    private fun assertInvalidPage(body: String) {
        expectPage(body)
        assertInvalidResponse()
        server.verify()
        server.reset()
    }

    private fun assertInvalidResponse() = assertEquals(
        OpenAiCostsClientException.Reason.INVALID_RESPONSE,
        assertThrows(OpenAiCostsClientException::class.java) { client.fetch(from, to) }.reason,
    )

    private fun expectPage(body: String) {
        server.expect(requestTo(containsString("/organization/costs"))).andRespond(withSuccess(body, MediaType.APPLICATION_JSON))
    }

    private fun page(start: Long, value: String, next: String?, currency: String = "usd") =
        pageOf(listOf(bucket(start, result(value, currency))), next)

    private fun emptyDays() = pageOf(listOf(bucket(firstDay, ""), bucket(secondDay, "")))

    private fun pageOf(buckets: List<String>, next: String? = null) = """
        {"object":"page","data":[${buckets.joinToString(",")}],"has_more":${next != null},"next_page":${next?.let { "\"$it\"" } ?: "null"}}
    """.trimIndent()

    private fun bucket(start: Long, results: String, end: Long = start + 86400) =
        """{"object":"bucket","start_time":$start,"end_time":$end,"results":[$results]}"""

    private fun result(value: String, currency: String = "usd") = """
        {"object":"organization.costs.result","amount":{"value":$value,"currency":"$currency"},"line_item":"gpt-5.6-luna, input","project_id":"proj_govbiz"}
    """.trimIndent()
}
