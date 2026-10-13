package ai.govbiz.core.aiusage.client

import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.domain.AiUsageAttribution
import ai.govbiz.core.aiusage.domain.AiUsageFeature
import ai.govbiz.core.aiusage.helper.AiUsageContextHelper
import ai.govbiz.core.aiusage.service.AiUsageService
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyList
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.HttpServerErrorException
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class AiUsageRecordingInterceptorTest {
    private val service = Mockito.mock(AiUsageService::class.java)
    private val builder = RestClient.builder()
        .requestInterceptor(AiUsageRecordingInterceptor(service, JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()))
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val client = builder.baseUrl("http://ai.test").build()
    private val usage = """[{"model":"gpt-5.6-sol-2026-07-30","serviceTier":"priority","calls":1,"inputTokens":900,"cachedInputTokens":0,"outputTokens":120},""" +
        """{"model":"text-embedding-3-small","serviceTier":"default","calls":2,"inputTokens":40,"cachedInputTokens":0,"outputTokens":0}]"""

    @Test
    fun recordsTheUsageHeaderWithTheCallersAccountAndFeature() {
        server.expect(requestTo("http://ai.test/internal/v1/support-program-rankings/rank")).andExpect(method(HttpMethod.POST))
            .andRespond(withSuccess("{}", MediaType.APPLICATION_JSON).header(AiUsageRecordingInterceptor.USAGE_HEADER, usage))

        val body = AiUsageContextHelper.attribute(7, AiUsageFeature.AI_SEARCH) {
            client.post().uri("/internal/v1/support-program-rankings/rank").retrieve().body(String::class.java)
        }

        assertEquals("{}", body)
        Mockito.verify(service).record(
            "support-program-rankings/rank",
            listOf(
                AiModelUsage("gpt-5.6-sol-2026-07-30", "priority", 1, 900, 0, 120),
                AiModelUsage("text-embedding-3-small", "default", 2, 40, 0, 0),
            ),
            AiUsageAttribution(7, AiUsageFeature.AI_SEARCH),
        )
    }

    @Test
    fun preservesBothCacheWriteCountersAndExplicitUnknownCountersFromTheAiServiceHeader() {
        val cacheUsage = """[
            {"model":"gpt-6-luna","serviceTier":"default","calls":2,"inputTokens":1000,"cachedInputTokens":100,
             "outputTokens":15,"cacheWriteInputTokens":600,"cacheWrite12hInputTokens":200},
            {"model":"gpt-5-nano","serviceTier":"default","calls":1,"inputTokens":50,"cachedInputTokens":10,
             "outputTokens":5,"cacheWriteInputTokens":null,"cacheWrite12hInputTokens":null}
        ]""".lineSequence().joinToString("") { it.trim() }
        server.expect(requestTo("http://ai.test/internal/v1/assistant/answers"))
            .andRespond(withSuccess("{}", MediaType.APPLICATION_JSON).header(AiUsageRecordingInterceptor.USAGE_HEADER, cacheUsage))

        val body = AiUsageContextHelper.attribute(7, AiUsageFeature.ASSISTANT) {
            client.post().uri("/internal/v1/assistant/answers").retrieve().body(String::class.java)
        }

        assertEquals("{}", body)
        Mockito.verify(service).record(
            "assistant/answers",
            listOf(
                AiModelUsage("gpt-6-luna", "default", 2, 1000, 100, 15, 600, 200),
                AiModelUsage("gpt-5-nano", "default", 1, 50, 10, 5, null, null),
            ),
            AiUsageAttribution(7, AiUsageFeature.ASSISTANT),
        )
        server.verify()
    }

    @Test
    fun aFailedAnswerStillRecordsTheTokensItSpent() {
        server.expect(requestTo("http://ai.test/internal/v1/combination-reviews/analyze"))
            .andRespond(withStatus(HttpStatus.BAD_GATEWAY).header(AiUsageRecordingInterceptor.USAGE_HEADER, usage))

        assertThrows(HttpServerErrorException::class.java) {
            client.post().uri("/internal/v1/combination-reviews/analyze").retrieve().toBodilessEntity()
        }

        Mockito.verify(service).record(Mockito.eq("combination-reviews/analyze") ?: "", anyList(), Mockito.isNull())
    }

    @Test
    fun aBrokenHeaderOrRecordingFailureNeverBreaksTheCall() {
        server.expect(requestTo("http://ai.test/internal/v1/assistant/answers"))
            .andRespond(withSuccess("{}", MediaType.APPLICATION_JSON).header(AiUsageRecordingInterceptor.USAGE_HEADER, "not-json"))
        server.expect(requestTo("http://ai.test/internal/v1/assistant/answers"))
            .andRespond(withSuccess("{}", MediaType.APPLICATION_JSON).header(AiUsageRecordingInterceptor.USAGE_HEADER, usage))
        Mockito.doThrow(IllegalStateException("db down")).`when`(service).record(anyString(), anyList(), Mockito.any())

        repeat(2) { assertEquals("{}", client.post().uri("/internal/v1/assistant/answers").retrieve().body(String::class.java)) }

        Mockito.verify(service, Mockito.times(1)).record(anyString(), anyList(), Mockito.any())
    }

    @Test
    fun operationsAreTheInternalPathWithoutItsPrefix() {
        assertEquals("support-program-index/search", AiUsageRecordingInterceptor.operationOf("/internal/v1/support-program-index/search"))
        assertEquals("unknown", AiUsageRecordingInterceptor.operationOf("/internal/v1/"))
    }
}
