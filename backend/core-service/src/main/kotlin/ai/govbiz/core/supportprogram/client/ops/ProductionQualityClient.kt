package ai.govbiz.core.supportprogram.client.ops

import ai.govbiz.core.supportprogram.client.ops.config.ProductionQualityProperties
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityMaterialRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualitySampleRequest
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import org.slf4j.LoggerFactory
import tools.jackson.databind.ObjectMapper

/** 검증 완료 표본을 최대 8건까지만 비동기로 전송한다. 수집 오류는 사용자 답변과 분리한다. */
class ProductionQualityClient(
    private val properties: ProductionQualityProperties,
    private val mapper: ObjectMapper,
    private val httpClient: HttpClient,
) : AutoCloseable {
    private val inFlight = Semaphore(8)

    fun record(material: ProductionQualityMaterialRequest, traceId: String?) {
        val endpoint = properties.endpoint ?: return
        val id = UUID.randomUUID()
        if (!selected(id)) return
        // 질문·답변의 민감정보와 근거의 주민번호·인증정보는 마스킹 전에 제외한다.
        if (sensitive(material.question) || sensitive(material.answer) ||
            material.chunks.any { chunk -> BLOCKED_PATTERNS.any { it.containsMatchIn(chunk.text) } }
        ) {
            logger.info("production_quality_sample_skipped reason=sensitive_content")
            return
        }
        if (!inFlight.tryAcquire()) {
            logger.warn("production_quality_sample_skipped reason=capacity")
            return
        }
        val startedAt = System.nanoTime()
        try {
            // 공고 문의처 때문에 표본 전체가 누락되지 않도록 수집용 근거 사본만 마스킹한다.
            val collectedMaterial = material.copy(chunks = material.chunks.map { chunk ->
                chunk.copy(text = CONTACT_PATTERNS.fold(chunk.text) { text, pattern -> pattern.replace(text, "[REDACTED]") })
            })
            val documentIds = material.chunks.map { it.documentId }.distinct()
            require(documentIds.size == 1)
            val payload = ProductionQualitySampleRequest(
                id = id.toString(), capturedAt = Instant.now().toString(), sampleRateBps = properties.rateBps,
                sourceDocumentId = documentIds.single(), traceId = traceId?.takeIf { TRACE_ID.matches(it) },
                release = properties.release.takeIf { RELEASE.matches(it) }, material = collectedMaterial,
                evidenceRedacted = collectedMaterial != material,
            )
            val body = mapper.writeValueAsBytes(payload)
            require(body.size <= 102_400)
            val request = HttpRequest.newBuilder(endpoint)
                .timeout(properties.requestTimeout)
                .header("Authorization", "Bearer ${properties.token}")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build()
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding()).whenComplete { response, failure ->
                inFlight.release()
                val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
                when {
                    failure != null -> {
                        val cause = if (failure is CompletionException) failure.cause else failure
                        val reason = if (cause is HttpTimeoutException) "timeout" else "transport"
                        // 응답을 못 받았어도 Ops가 이미 저장했을 수 있다. 재전송하거나 실패로 단정하지 않는다.
                        logger.warn("production_quality_sample_delivery_unknown reason={} sample_id={} elapsed_ms={}", reason, id, elapsedMs)
                    }
                    response.statusCode() !in 200..299 -> logger.warn(
                        "production_quality_sample_failed reason=rejected sample_id={} status={} elapsed_ms={}",
                        id, response.statusCode(), elapsedMs,
                    )
                    else -> logger.info(
                        "production_quality_sample_accepted sample_id={} status={} elapsed_ms={}",
                        id, response.statusCode(), elapsedMs,
                    )
                }
            }
        } catch (_: Exception) {
            inFlight.release()
            logger.warn("production_quality_sample_failed reason=dispatch sample_id={}", id)
        }
    }

    // 새 UUID의 균등한 하위 비트로 표본을 선택한다. 질문·계정·trace ID에 따라 편향되지 않는다.
    internal fun selected(id: UUID): Boolean =
        java.lang.Long.remainderUnsigned(id.leastSignificantBits, 10_000) < properties.rateBps

    private fun sensitive(text: String): Boolean =
        CONTACT_PATTERNS.any { it.containsMatchIn(text) } || BLOCKED_PATTERNS.any { it.containsMatchIn(text) }

    override fun close() = httpClient.shutdown()

    companion object {
        private val logger = LoggerFactory.getLogger(ProductionQualityClient::class.java)
        private val TRACE_ID = Regex("[0-9a-f]{32}")
        private val RELEASE = Regex("[0-9a-f]{40}")
        // 고정 패턴 검사이며 완전한 개인정보 탐지로 해석하지 않는다.
        private val CONTACT_PATTERNS = listOf(
            Regex("[A-Z0-9._%+\\-]+@[A-Z0-9.\\-]+\\.[A-Z]{2,}", RegexOption.IGNORE_CASE),
            Regex("(?<![0-9])(?:0[0-9]{1,2}|\\+82[ \\-]?[0-9]{1,2})[ \\-]?[0-9]{3,4}[ \\-]?[0-9]{4}(?![0-9])"),
        )
        private val BLOCKED_PATTERNS = listOf(
            Regex("(?<![0-9])[0-9]{6}[ \\-]?[1-8][0-9]{6}(?![0-9])"),
            Regex("(?:Bearer\\s+\\S+|(?:api[_-]?key|password|secret|token)\\s*[:=]\\s*\\S+|sk-[A-Z0-9_-]{16,}|eyJ[A-Z0-9_-]+\\.[A-Z0-9_-]+\\.[A-Z0-9_-]+)", RegexOption.IGNORE_CASE),
        )
    }
}
