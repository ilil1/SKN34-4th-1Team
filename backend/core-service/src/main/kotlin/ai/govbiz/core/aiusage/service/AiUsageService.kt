package ai.govbiz.core.aiusage.service

import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.domain.accessSummaryOf
import ai.govbiz.core.admin.service.AdminAccessLogService
import ai.govbiz.core.aiusage.config.AiCostProperties
import ai.govbiz.core.aiusage.domain.AiCostDay
import ai.govbiz.core.aiusage.domain.AiCostSummary
import ai.govbiz.core.aiusage.domain.AiModelPrice
import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.domain.AiUsageAttribution
import ai.govbiz.core.aiusage.domain.AiUsageTotals
import ai.govbiz.core.aiusage.domain.NewAiModelPrice
import ai.govbiz.core.aiusage.repository.AiUsageRepository
import ai.govbiz.core.aiusage.service.exception.AiModelPriceConflictException
import java.math.BigDecimal
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional

/**
 * ai-service가 돌려준 OpenAI 사용량을 계정·기능과 함께 남기고 그때의 가격표로 추정 비용을 매깁니다. 관리자 화면에는 기간별 추정 비용과
 * OpenAI가 알려 준 실제 비용을 함께 보입니다. 사용량 기록은 부른 기능의 transaction과 따로 남겨, 기능이 되돌려져도 쓴 토큰은 남습니다.
 */
@Service
class AiUsageService(
    private val repository: AiUsageRepository,
    private val accessLog: AdminAccessLogService,
    private val properties: AiCostProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    fun record(operation: String, usages: List<AiModelUsage>, attribution: AiUsageAttribution?) {
        if (usages.isEmpty()) return
        val now = LocalDateTime.now(clock)
        val pricingDate = LocalDate.now(clock.withZone(ZoneOffset.UTC))
        val prices = repository.findPrices()
        usages.forEach { usage ->
            repository.insertUsage(now, attribution, operation, usage, AiModelPrice.find(prices, usage.model, usage.serviceTier, pricingDate))
        }
    }

    /** 회원 이메일이 들어 있으므로 조회마다 관리자 접속기록을 남깁니다. */
    fun summary(actor: AdminActor, from: LocalDate, to: LocalDate): AiCostSummary {
        require(!to.isBefore(from) && ChronoUnit.DAYS.between(from, to) < MAX_DAYS) { "period must be 1~$MAX_DAYS days" }
        val estimated = repository.sumByDay(from, to)
        val comparison = repository.comparison(from, to, properties.openaiProjectId, LocalDate.now(clock.withZone(ZoneOffset.UTC)))
        val days = generateSequence(from) { it.plusDays(1) }.takeWhile { !it.isAfter(to) }.map { day ->
            val (usd, calls) = estimated[day] ?: (BigDecimal.ZERO to 0L)
            AiCostDay(day, usd, calls, null)
        }.toList()
        val topAccounts = repository.sumTopAccounts(from, to, TOP_ACCOUNTS)
        val summary = AiCostSummary(
            from = from,
            to = to,
            totals = repository.sumTotals(from, to, utc = true),
            actualUsd = comparison.actualUsd,
            actualConfigured = properties.adminKeyConfigured,
            actualFetchedAt = comparison.fetchedAt?.plusHours(9),
            krwPerUsd = properties.krwPerUsd,
            byFeature = repository.sumByFeature(from, to),
            byModel = repository.sumByModel(from, to),
            days = days,
            topAccounts = topAccounts,
            comparison = comparison,
        )
        accessLog.record(actor, AdminAccessAction.AI_COST_VIEW, requestSummary = accessSummaryOf("from" to from, "to" to to, "accounts" to topAccounts.size))
        return summary
    }

    /** 관리자 계정 상세의 이번 달(서울) AI 사용 합계입니다. */
    fun monthTotals(accountId: Long): AiUsageTotals {
        val today = LocalDate.now(clock)
        return repository.sumTotals(today.withDayOfMonth(1), today, accountId)
    }

    fun prices(): List<AiModelPrice> = repository.findPrices()

    fun addPrice(actor: AdminActor, price: NewAiModelPrice): AiModelPrice = try {
        repository.insertPrice(price, actor.accountId, LocalDateTime.now(clock))
    } catch (_: DuplicateKeyException) {
        throw AiModelPriceConflictException()
    }

    private companion object {
        const val MAX_DAYS = 92L
        const val TOP_ACCOUNTS = 10
    }
}
