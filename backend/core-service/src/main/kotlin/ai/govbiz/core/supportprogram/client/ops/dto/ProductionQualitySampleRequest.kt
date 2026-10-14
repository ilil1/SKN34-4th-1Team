package ai.govbiz.core.supportprogram.client.ops.dto

import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonInclude

data class ProductionQualityChunkRequest(
    val id: String,
    @get:JsonProperty("document_id") val documentId: String,
    val order: Int,
    val text: String,
)

data class ProductionQualityMaterialRequest(
    val question: String,
    val chunks: List<ProductionQualityChunkRequest>,
    val answer: String,
    @get:JsonProperty("answer_status") val answerStatus: String,
    @get:JsonProperty("citation_chunk_ids") val citationChunkIds: List<String>,
)

@JsonInclude(JsonInclude.Include.ALWAYS)
data class ProductionQualitySampleRequest(
    @get:JsonProperty("schema_version") val schemaVersion: Int = 1,
    val id: String,
    @get:JsonProperty("captured_at") val capturedAt: String,
    val scope: String = "support-program-evidence-answer",
    @get:JsonProperty("sample_rate_bps") val sampleRateBps: Int,
    @get:JsonProperty("source_document_id") val sourceDocumentId: String,
    @get:JsonProperty("trace_id") val traceId: String?,
    val release: String?,
    val material: ProductionQualityMaterialRequest,
    @get:JsonProperty("evidence_redacted") val evidenceRedacted: Boolean = false,
)
