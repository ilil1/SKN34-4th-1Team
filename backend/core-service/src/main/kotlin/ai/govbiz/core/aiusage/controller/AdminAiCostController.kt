package ai.govbiz.core.aiusage.controller

import ai.govbiz.core.admin.web.AdminPrincipal
import ai.govbiz.core.aiusage.controller.dto.AdminAiCostSummaryResponse
import ai.govbiz.core.aiusage.controller.dto.AdminAiCostSyncResponse
import ai.govbiz.core.aiusage.controller.dto.AdminAiModelPriceRequest
import ai.govbiz.core.aiusage.controller.dto.AdminAiModelPriceResponse
import ai.govbiz.core.aiusage.service.AiCostSyncService
import ai.govbiz.core.aiusage.service.AiUsageService
import ai.govbiz.core.aiusage.service.exception.AiCostSyncException
import ai.govbiz.core.aiusage.service.exception.AiModelPriceConflictException
import jakarta.validation.Valid
import java.time.LocalDate
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * 관리자 AI 비용 화면입니다. 기간(UTC 날짜, 최대 92일)의 조직 사용량·비용 비교와 앱 기능·모델·회원별 합계, 가격표를 다룹니다.
 * [AdminPrincipal]을 받으므로 세션이 없으면 401, 관리자가 아니면 403입니다. 요약 조회는 회원 이메일이 있어 접속기록을 남깁니다.
 */
@RestController
@RequestMapping("/api/v1/admin/ai-costs")
class AdminAiCostController(
    private val usage: AiUsageService,
    private val costs: AiCostSyncService,
) {

    @GetMapping
    fun summary(
        admin: AdminPrincipal,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) from: LocalDate,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) to: LocalDate,
    ): ResponseEntity<AdminAiCostSummaryResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(AdminAiCostSummaryResponse.from(usage.summary(admin.actor, from, to)))

    @GetMapping("/prices")
    fun prices(admin: AdminPrincipal): List<AdminAiModelPriceResponse> = usage.prices().map(AdminAiModelPriceResponse::from)

    /** 가격은 고치지 않고 시작일이 다른 새 행으로 더합니다. 같은 모델·등급·시작일이 있으면 409입니다. */
    @PostMapping("/prices")
    fun addPrice(admin: AdminPrincipal, @RequestBody @Valid request: AdminAiModelPriceRequest): ResponseEntity<AdminAiModelPriceResponse> =
        ResponseEntity.status(HttpStatus.CREATED).body(AdminAiModelPriceResponse.from(usage.addPrice(admin.actor, request.toDomain())))

    /** 관리자 키가 없으면 503 `OPENAI_ADMIN_KEY_MISSING`, 키가 거절되면 502 `OPENAI_ADMIN_KEY_REJECTED`입니다. */
    @PostMapping("/sync")
    fun sync(admin: AdminPrincipal): AdminAiCostSyncResponse = AdminAiCostSyncResponse.from(costs.sync())

    @ExceptionHandler(AiCostSyncException::class)
    fun handleSync(error: AiCostSyncException): ResponseEntity<ProblemDetail> {
        val (status, code, detail) = when (error.reason) {
            AiCostSyncException.Reason.ADMIN_KEY_MISSING ->
                Triple(HttpStatus.SERVICE_UNAVAILABLE, "OPENAI_ADMIN_KEY_MISSING", "OpenAI 조직 관리자 키(OPENAI_ADMIN_KEY)가 설정되지 않아 실제 비용을 가져올 수 없습니다.")
            AiCostSyncException.Reason.ADMIN_KEY_REJECTED ->
                Triple(HttpStatus.BAD_GATEWAY, "OPENAI_ADMIN_KEY_REJECTED", "OpenAI가 관리자 키를 거절했습니다. 조직 관리자 키인지 확인해 주세요.")
            AiCostSyncException.Reason.UNAVAILABLE ->
                Triple(HttpStatus.BAD_GATEWAY, "OPENAI_COSTS_UNAVAILABLE", "OpenAI 비용을 지금 가져오지 못했습니다. 기존 값은 그대로 두었습니다.")
            AiCostSyncException.Reason.INVALID_RESPONSE ->
                Triple(HttpStatus.BAD_GATEWAY, "OPENAI_COSTS_INVALID_RESPONSE", "OpenAI 비용 응답을 확인하지 못해 반영하지 않았습니다.")
        }
        return problem(status, code, detail)
    }

    @ExceptionHandler(AiModelPriceConflictException::class)
    fun handlePriceConflict(): ResponseEntity<ProblemDetail> =
        problem(HttpStatus.CONFLICT, "AI_MODEL_PRICE_CONFLICT", "같은 모델·처리 등급·시작일의 가격이 이미 있습니다.")

    @ExceptionHandler(IllegalArgumentException::class)
    fun handleInvalid(error: IllegalArgumentException): ResponseEntity<ProblemDetail> =
        problem(HttpStatus.BAD_REQUEST, "AI_COST_REQUEST_INVALID", error.message ?: "요청 값을 확인해 주세요.")

    private fun problem(status: HttpStatus, code: String, detail: String): ResponseEntity<ProblemDetail> {
        val problem = ProblemDetail.forStatusAndDetail(status, detail)
        problem.setProperty("code", code)
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore()).body(problem)
    }
}
