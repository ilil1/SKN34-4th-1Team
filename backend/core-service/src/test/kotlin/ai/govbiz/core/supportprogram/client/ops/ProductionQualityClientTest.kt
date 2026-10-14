package ai.govbiz.core.supportprogram.client.ops

import ai.govbiz.core.supportprogram.client.ops.config.ProductionQualityProperties
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityChunkRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityMaterialRequest
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import java.io.ByteArrayOutputStream
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.nio.ByteBuffer
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Flow
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.slf4j.LoggerFactory
import tools.jackson.module.kotlin.jacksonObjectMapper

class ProductionQualityClientTest {
    private val mapper = jacksonObjectMapper()
    private val secret = "test-secret-never-in-body-".repeat(2)
    private val chunk = ProductionQualityChunkRequest("a".repeat(64), "BIZINFO:PBLN_TEST", 0, "신청은 온라인으로 접수합니다.")
    private val material = ProductionQualityMaterialRequest("신청 방법은?", listOf(chunk), "온라인 접수입니다.", "ANSWERED", listOf(chunk.id))

    @Test
    fun sendsOnlyTheValidatedSampleContractWithoutWaitingForTheResponse() {
        val requests = mutableListOf<HttpRequest>()
        val pending = CompletableFuture<HttpResponse<Void>>()
        val client = ProductionQualityClient(properties(), mapper, http(requests, pending))

        client.record(material, "b".repeat(32))

        assertFalse(pending.isDone)
        val request = requests.single()
        assertEquals("http://ops.test/internal/llmops/production-samples", request.uri().toString())
        assertEquals("Bearer $secret", request.headers().firstValue("Authorization").orElseThrow())
        assertEquals(15L, request.timeout().orElseThrow().seconds)
        val body = mapper.readTree(body(request))
        assertEquals(1, body["schema_version"].asInt())
        assertEquals("support-program-evidence-answer", body["scope"].asText())
        assertEquals(10_000, body["sample_rate_bps"].asInt())
        assertEquals(chunk.documentId, body["source_document_id"].asText())
        assertEquals("b".repeat(32), body["trace_id"].asText())
        assertEquals("c".repeat(40), body["release"].asText())
        assertFalse(body["evidence_redacted"].asBoolean())
        assertEquals(material.answerStatus, body["material"]["answer_status"].asText())
        assertEquals(chunk.documentId, body["material"]["chunks"][0]["document_id"].asText())
        assertEquals(chunk.id, body["material"]["citation_chunk_ids"][0].asText())
        assertFalse(body.has("model"))
        assertFalse(body.has("sourceDocumentId"))
        assertFalse(body.toString().contains(secret))
        UUID.fromString(body["id"].asText())
        java.time.Instant.parse(body["captured_at"].asText())
    }

    @Test
    fun disablesCollectionByDefaultAndSamplesUniformRequestIdsAtTheConfiguredBoundary() {
        val http = mock(HttpClient::class.java)
        val disabled = ProductionQualityClient(ProductionQualityProperties(), mapper, http)
        disabled.record(material, null)
        verifyNoInteractions(http)

        val partial = ProductionQualityClient(properties(rate = 1_000), mapper, http)
        assertTrue(partial.selected(UUID(0, 999)))
        assertFalse(partial.selected(UUID(0, 1_000)))
        assertTrue(partial.selected(UUID(0, 10_999)))
    }

    @Test
    fun includesExplicitNullsForUnknownTraceAndReleaseAndBoundsUtf8BodySize() {
        val requests = mutableListOf<HttpRequest>()
        val client = ProductionQualityClient(
            ProductionQualityProperties(10_000, "http://ops.test", secret, "abc1234"),
            mapper, http(requests, CompletableFuture()),
        )
        client.record(material, null)
        val body = mapper.readTree(body(requests.single()))
        assertTrue(body.has("trace_id") && body["trace_id"].isNull)
        assertTrue(body.has("release") && body["release"].isNull)
        client.record(material.copy(chunks = List(5) { chunk.copy(order = it, text = "가".repeat(12_000)) }), null)
        assertEquals(1, requests.size)
    }

    @Test
    fun boundsPendingRequestsAndReleasesCapacityAfterFailureWithoutRetryOrPrivateLogs() {
        val requests = mutableListOf<HttpRequest>()
        val pending = CompletableFuture<HttpResponse<Void>>()
        val client = ProductionQualityClient(properties(), mapper, http(requests, pending))
        withLogs { logs ->
            repeat(9) { client.record(material, null) }
            assertEquals(8, requests.size)
            assertTrue(logs.list.any { it.formattedMessage.endsWith("reason=capacity") })
            pending.completeExceptionally(IllegalStateException("private response $secret"))
            assertEquals(8, requests.size)
            client.record(material, null)
            assertEquals(9, requests.size)
            assertTrue(logs.list.any { it.formattedMessage.startsWith("production_quality_sample_delivery_unknown reason=transport ") })
            assertTrue(logs.list.none { it.formattedMessage.contains("private response") || it.formattedMessage.contains(secret) })
            assertTrue(logs.list.all { it.throwableProxy == null })
        }
    }

    @Test
    fun discardsSensitiveQuestionsAndAnswersBeforeNetworkAccess() {
        val http = mock(HttpClient::class.java)
        val client = ProductionQualityClient(properties(), mapper, http)
        val privateValues = listOf("owner@example.com", "010-1234-5678", "900101-1234567", "Bearer top-secret", "api_key=private")
        withLogs { logs ->
            privateValues.forEach { private ->
                client.record(material.copy(question = private), null)
                client.record(material.copy(answer = private), null)
            }
            verifyNoInteractions(http)
            assertEquals(privateValues.size * 2, logs.list.size)
            assertTrue(logs.list.all { it.formattedMessage == "production_quality_sample_skipped reason=sensitive_content" })
        }
    }

    @Test
    fun masksEvidenceContactsBeforeTransmissionWithoutChangingTheAnswerOrCitationProvenance() {
        val requests = mutableListOf<HttpRequest>()
        val client = ProductionQualityClient(properties(), mapper, http(requests, CompletableFuture()))
        val evidence = "AI·ICT분야 국내기업 지원. 문의처 02-3460-7474, aiax@kotra.or.kr"
        val source = material.copy(chunks = listOf(chunk.copy(text = evidence), chunk.copy(id = "d".repeat(64), order = 1)))
        withLogs { logs ->
            client.record(source, null)
            val sent = mapper.readTree(body(requests.single()))
            assertTrue(sent["evidence_redacted"].asBoolean())
            val collected = sent["material"]
            assertEquals("AI·ICT분야 국내기업 지원. 문의처 [REDACTED], [REDACTED]", collected["chunks"][0]["text"].asText())
            assertEquals(chunk.text, collected["chunks"][1]["text"].asText())
            assertEquals(source.question, collected["question"].asText())
            assertEquals(source.answer, collected["answer"].asText())
            assertEquals(source.answerStatus, collected["answer_status"].asText())
            assertEquals(chunk.id, collected["citation_chunk_ids"][0].asText())
            source.chunks.forEachIndexed { index, original ->
                assertEquals(original.id, collected["chunks"][index]["id"].asText())
                assertEquals(original.documentId, collected["chunks"][index]["document_id"].asText())
                assertEquals(original.order, collected["chunks"][index]["order"].asInt())
            }
            assertEquals(evidence, source.chunks[0].text)
            assertFalse(sent.toString().contains("02-3460-7474") || sent.toString().contains("aiax@kotra.or.kr"))
            assertTrue(logs.list.isEmpty())
        }
    }

    @Test
    fun discardsIdentityAndCredentialsInEvidenceBeforeMaskingContacts() {
        val http = mock(HttpClient::class.java)
        val client = ProductionQualityClient(properties(), mapper, http)
        val blocked = listOf("900101-1234567", "Bearer owner@example.com", "api_key=010-1234-5678", "sk-abcdefghijklmnop")
        withLogs { logs ->
            blocked.forEach { private ->
                client.record(material.copy(chunks = listOf(chunk, chunk.copy(id = "d".repeat(64), text = "문의 02-3460-7474 $private"))), null)
            }
            verifyNoInteractions(http)
            assertEquals(blocked.size, logs.list.size)
            assertTrue(logs.list.all { it.formattedMessage == "production_quality_sample_skipped reason=sensitive_content" })
        }
    }

    @Test
    fun dispatchAndRejectedResponsesDoNotFailTheUserRequestOrLeakErrors() {
        val http = mock(HttpClient::class.java)
        doThrow(IllegalStateException("private endpoint $secret")).`when`(http)
            .sendAsync(any(HttpRequest::class.java), any<HttpResponse.BodyHandler<Void>>())
        withLogs { logs ->
            val client = ProductionQualityClient(properties(), mapper, http)
            repeat(9) { client.record(material, null) }
            verify(http, times(9)).sendAsync(any(HttpRequest::class.java), any<HttpResponse.BodyHandler<Void>>())
            assertTrue(logs.list.all { it.formattedMessage.startsWith("production_quality_sample_failed reason=dispatch ") && it.throwableProxy == null })
        }
        val response = mock(HttpResponse::class.java) as HttpResponse<Void>
        doReturn(403).`when`(response).statusCode()
        withLogs { logs ->
            ProductionQualityClient(properties(), mapper, http(mutableListOf(), CompletableFuture.completedFuture(response)))
                .record(material, null)
            assertTrue(logs.list.single().formattedMessage.startsWith("production_quality_sample_failed reason=rejected sample_id="))
            assertTrue(logs.list.single().formattedMessage.contains(" status=403 elapsed_ms="))
        }
    }

    @Test
    fun boundsAndAppliesTheConfigurableRequestTimeout() {
        for (timeout in listOf(Duration.ZERO, Duration.ofMillis(999), Duration.ofMillis(30_001))) {
            assertThrows(IllegalArgumentException::class.java) {
                ProductionQualityProperties(requestTimeout = timeout)
            }
        }
        for (seconds in listOf(1L, 30L)) {
            val requests = mutableListOf<HttpRequest>()
            ProductionQualityClient(properties(timeout = Duration.ofSeconds(seconds)), mapper, http(requests, CompletableFuture()))
                .record(material, null)
            assertEquals(Duration.ofSeconds(seconds), requests.single().timeout().orElseThrow())
        }
    }

    @Test
    fun correlatesAcceptedAndUnacknowledgedSamplesWithoutRetryOrPrivateLogs() {
        for (failure in listOf(null, HttpTimeoutException(secret), CompletionException(HttpTimeoutException(secret)))) {
            val requests = mutableListOf<HttpRequest>()
            val pending = CompletableFuture<HttpResponse<Void>>()
            val client = ProductionQualityClient(properties(), mapper, http(requests, pending))
            withLogs { logs ->
                repeat(8) { client.record(material, null) }
                assertFalse(pending.isDone)
                if (failure == null) {
                    val response = mock(HttpResponse::class.java) as HttpResponse<Void>
                    doReturn(201).`when`(response).statusCode()
                    pending.complete(response)
                } else {
                    pending.completeExceptionally(failure)
                }
                assertEquals(8, requests.size)
                val ids = requests.map { mapper.readTree(body(it))["id"].asText() }
                assertEquals(8, logs.list.size)
                val loggedIds = mutableSetOf<String>()
                logs.list.forEach { log ->
                    val message = log.formattedMessage
                    loggedIds.add(ids.single { message.contains("sample_id=$it ") })
                    assertTrue(message.contains("elapsed_ms="))
                    if (failure == null) {
                        assertTrue(message.startsWith("production_quality_sample_accepted "))
                        assertTrue(message.contains(" status=201 "))
                    } else {
                        assertTrue(message.startsWith("production_quality_sample_delivery_unknown reason=timeout "))
                        assertFalse(message.contains("status="))
                    }
                    assertFalse(message.contains(secret) || message.contains(material.question) || message.contains(material.answer))
                    assertNull(log.throwableProxy)
                }
                assertEquals(ids.toSet(), loggedIds)
                client.record(material, null)
                assertEquals(9, requests.size)
            }
        }
    }

    @Test
    fun validatesOnlyExplicitlyEnabledConfigurationAndDoesNotExposeTokenInToString() {
        assertNull(ProductionQualityProperties(baseUrl = "bad", token = "short").endpoint)
        for (url in listOf("", "file:///tmp/data", "http://ops.test/path", "http://user:password@ops.test", "http://ops.test?token=private")) {
            assertThrows(IllegalArgumentException::class.java) { ProductionQualityProperties(1, url, secret) }
        }
        assertThrows(IllegalArgumentException::class.java) { properties(rate = 10_001) }
        assertThrows(IllegalArgumentException::class.java) { ProductionQualityProperties(1, "http://ops.test", "short") }
        assertFalse(properties().toString().contains(secret))
    }

    private fun properties(rate: Int = 10_000, timeout: Duration = Duration.ofSeconds(15)) =
        ProductionQualityProperties(rate, "http://ops.test", secret, "c".repeat(40), timeout)

    private fun http(requests: MutableList<HttpRequest>, response: CompletableFuture<HttpResponse<Void>>): HttpClient =
        mock(HttpClient::class.java).also { client ->
            doAnswer { invocation -> requests.add(invocation.getArgument(0)); response }.`when`(client)
                .sendAsync(any(HttpRequest::class.java), any<HttpResponse.BodyHandler<Void>>())
        }

    private fun body(request: HttpRequest): ByteArray {
        val bytes = ByteArrayOutputStream()
        val completed = CountDownLatch(1)
        request.bodyPublisher().orElseThrow().subscribe(object : Flow.Subscriber<ByteBuffer> {
            override fun onSubscribe(subscription: Flow.Subscription) = subscription.request(Long.MAX_VALUE)
            override fun onNext(buffer: ByteBuffer) {
                val value = ByteArray(buffer.remaining())
                buffer.get(value)
                bytes.write(value)
            }
            override fun onError(error: Throwable) = completed.countDown()
            override fun onComplete() = completed.countDown()
        })
        assertTrue(completed.await(1, TimeUnit.SECONDS))
        return bytes.toByteArray()
    }

    private fun withLogs(action: (ListAppender<ILoggingEvent>) -> Unit) {
        val logger = LoggerFactory.getLogger(ProductionQualityClient::class.java) as Logger
        val appender = ListAppender<ILoggingEvent>().also { it.start() }
        logger.addAppender(appender)
        try { action(appender) } finally { logger.detachAppender(appender); appender.stop() }
    }
}
