package ai.govbiz.core.aiusage.repository

import ai.govbiz.core.aiusage.domain.AiModelPrice
import ai.govbiz.core.aiusage.domain.AiCostComparison
import ai.govbiz.core.aiusage.domain.AiCostComparisonDay
import ai.govbiz.core.aiusage.domain.AiModelUsage
import ai.govbiz.core.aiusage.domain.AiUsageAccount
import ai.govbiz.core.aiusage.domain.AiUsageAttribution
import ai.govbiz.core.aiusage.domain.AiUsageGroup
import ai.govbiz.core.aiusage.domain.AiUsageTotals
import ai.govbiz.core.aiusage.domain.NewAiModelPrice
import ai.govbiz.core.aiusage.domain.OpenAiCostLine
import ai.govbiz.core.aiusage.domain.OpenAiUsageLine
import ai.govbiz.core.aiusage.repository.mapper.AiCostDailyDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiModelPriceDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiUsageMapper
import ai.govbiz.core.aiusage.repository.mapper.AiUsageRecordDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiUsageTotalsDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiProviderUsageDbRow
import ai.govbiz.core.aiusage.repository.mapper.AiCostSyncDayDbRow
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** AI 사용 기록·가격표·일별 비용을 저장합니다. 여러 장부의 동기화 transaction은 [replaceCostSnapshot]이 소유합니다. */
@Repository
class AiUsageRepository(private val mapper: AiUsageMapper) {

    fun insertUsage(
        occurredAt: LocalDateTime,
        attribution: AiUsageAttribution?,
        operation: String,
        usage: AiModelUsage,
        price: AiModelPrice?,
    ) {
        mapper.insertUsage(
            AiUsageRecordDbRow(
                occurredAt = occurredAt.truncatedTo(ChronoUnit.MICROS),
                usageDate = occurredAt.toLocalDate(),
                accountId = attribution?.accountId,
                feature = attribution?.feature?.name,
                operation = operation,
                model = usage.model,
                serviceTier = usage.serviceTier,
                callCount = usage.calls,
                inputTokens = usage.inputTokens,
                cachedInputTokens = usage.cachedInputTokens,
                outputTokens = usage.outputTokens,
                estimatedCostUsd = price?.costUsd(usage),
                priceId = price?.id,
                cacheWriteInputTokens = usage.cacheWriteInputTokens,
                cacheWrite12hInputTokens = usage.cacheWrite12hInputTokens,
            ),
        )
    }

    fun findPrices(): List<AiModelPrice> = mapper.findPrices().map { it.toDomain() }

    fun insertPrice(price: NewAiModelPrice, createdBy: Long, createdAt: LocalDateTime): AiModelPrice {
        val row = AiModelPriceDbRow(
            modelPrefix = price.modelPrefix,
            serviceTier = price.serviceTier,
            inputUsdPerMillion = price.inputUsdPerMillion,
            cachedInputUsdPerMillion = price.cachedInputUsdPerMillion,
            outputUsdPerMillion = price.outputUsdPerMillion,
            effectiveFrom = price.effectiveFrom,
            note = price.note,
            createdByAccountId = createdBy,
            createdAt = createdAt.truncatedTo(ChronoUnit.MICROS),
            cacheWriteInputUsdPerMillion = price.cacheWriteInputUsdPerMillion,
            cacheWrite12hInputUsdPerMillion = price.cacheWrite12hInputUsdPerMillion,
        )
        check(mapper.insertPrice(row) == 1 && row.id > 0) { "AI model price was not stored" }
        return row.toDomain()
    }

    fun sumTotals(from: LocalDate, to: LocalDate, accountId: Long? = null, utc: Boolean = false): AiUsageTotals = mapper.sumTotals(from, to, accountId, utc).toTotals()

    fun sumByFeature(from: LocalDate, to: LocalDate): List<AiUsageGroup> =
        mapper.sumByFeature(from, to).map { AiUsageGroup(it.groupKey, null, it.toTotals()) }

    fun sumByModel(from: LocalDate, to: LocalDate): List<AiUsageGroup> =
        mapper.sumByModel(from, to).map { AiUsageGroup(it.groupKey, it.serviceTier, it.toTotals()) }

    /** UTC 날짜별 (앱 추정 USD, 호출 수)입니다. */
    fun sumByDay(from: LocalDate, to: LocalDate): Map<LocalDate, Pair<BigDecimal, Long>> =
        mapper.sumByDay(from, to).associate { requireNotNull(it.day) to (it.estimatedUsd to it.calls) }

    fun sumTopAccounts(from: LocalDate, to: LocalDate, limit: Int): List<AiUsageAccount> =
        mapper.sumTopAccounts(from, to, limit).map { AiUsageAccount(requireNotNull(it.accountId), it.email.orEmpty(), it.planCode, it.toTotals()) }

    /** OpenAI 하루(UTC)별 실제 비용입니다. */
    fun sumActualByDay(from: LocalDate, to: LocalDate): Map<LocalDate, BigDecimal> =
        mapper.sumActualByDay(from, to).associate { requireNotNull(it.day) to it.estimatedUsd }

    fun findActualFetchedAt(): LocalDateTime? = mapper.findActualFetchedAt()

    /** 가져온 기간의 실제 비용을 새 값으로 바꿉니다. 부르는 Service의 transaction 하나에서 지우고 다시 넣습니다. */
    fun replaceActualCosts(from: LocalDate, to: LocalDate, lines: List<OpenAiCostLine>, fetchedAt: LocalDateTime) {
        mapper.deleteActualCosts(from, to)
        val at = fetchedAt.truncatedTo(ChronoUnit.MICROS)
        lines.forEach { line ->
            mapper.insertActualCost(AiCostDailyDbRow(line.date, line.projectId, line.lineItem, line.amountUsd, at))
        }
    }

    /** 세 API의 모든 페이지를 검증한 뒤에만 호출합니다. 비어 있는 날도 기록하고 세 장부를 함께 갱신합니다. */
    @Transactional
    fun replaceCostSnapshot(
        from: LocalDate,
        to: LocalDate,
        usages: List<OpenAiUsageLine>,
        costs: List<OpenAiCostLine>,
        projectScope: String,
        fetchedAt: LocalDateTime, // UTC
        startedAt: LocalDateTime = fetchedAt, // UTC, 첫 API를 부르기 전 시각
    ) {
        val started = startedAt.truncatedTo(ChronoUnit.MICROS)
        val latestStarted = checkNotNull(mapper.lockLatestSyncStartedAt()) { "AI cost sync state is missing" }
        if (started.isBefore(latestStarted)) throw java.util.ConcurrentModificationException("A newer AI cost snapshot is already stored")
        val prices = findPrices()
        mapper.deleteProviderUsage(from, to)
        mapper.deleteSyncDays(from, to)
        replaceActualCosts(from, to, costs, fetchedAt.plusHours(9)) // 기존 실제 비용 표의 저장시각 계약은 KST
        usages.forEach { usage ->
            val tier = when {
                usage.batch == true -> "batch"
                usage.usageKind == "completions" && usage.batch == null -> "unknown"
                usage.serviceTier in setOf("fast", "fast-tier") -> "priority"
                else -> usage.serviceTier
            }
            val price = AiModelPrice.find(prices, usage.model, tier, usage.date)
            mapper.insertProviderUsage(AiProviderUsageDbRow(
                usageDate = usage.date, usageKind = usage.usageKind, projectId = usage.projectId,
                model = usage.model, serviceTier = usage.serviceTier,
                batchKind = when (usage.batch) { true -> 1; false -> 0; null -> -1 },
                callCount = usage.calls, inputTokens = usage.inputTokens, cachedInputTokens = usage.cachedInputTokens,
                cacheWriteInputTokens = usage.cacheWriteTokens, cacheWrite12hInputTokens = usage.cacheWrite12hTokens,
                outputTokens = usage.outputTokens,
                estimatedCostUsd = price?.costUsd(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheWrite12hTokens),
                priceId = price?.id,
            ))
        }
        val costsByDay = costs.groupBy { it.date }
        generateSequence(from) { it.plusDays(1) }.takeWhile { !it.isAfter(to) }.forEach { day ->
            mapper.insertSyncDay(AiCostSyncDayDbRow(day, projectScope,
                costsByDay[day].orEmpty().fold(BigDecimal.ZERO) { sum, line -> sum + line.amountUsd }, fetchedAt.truncatedTo(ChronoUnit.MICROS)))
        }
        check(mapper.updateLatestSyncStartedAt(started) == 1) { "AI cost sync state was not stored" }
    }

    /** 단일 SQL로 사용량·비용·조회 범위를 읽어 서로 다른 동기화 결과가 섞이지 않도록 합니다. */
    fun comparison(from: LocalDate, to: LocalDate, projectScope: String, todayUtc: LocalDate): AiCostComparison {
        val stored = mapper.findProviderDays(from, to, projectScope)
        val byDay = stored.associateBy { requireNotNull(it.usageDate) }
        val dates = generateSequence(from) { it.plusDays(1) }.takeWhile { !it.isAfter(to) }.toList()
        val complete = dates.all { it in byDay }
        val totals = stored.map { it.totals.toTotals() }
        val combined = if (!complete) null else AiUsageTotals(
            calls = totals.sumOf { it.calls }, inputTokens = totals.sumOf { it.inputTokens },
            cachedInputTokens = totals.sumOf { it.cachedInputTokens }, outputTokens = totals.sumOf { it.outputTokens },
            estimatedUsd = totals.fold(BigDecimal.ZERO) { sum, value -> sum + value.estimatedUsd }, unpricedCalls = totals.sumOf { it.unpricedCalls },
            cacheWriteInputTokens = if (totals.any { it.cacheWriteInputTokens == null }) null else totals.sumOf { requireNotNull(it.cacheWriteInputTokens) },
            cacheWrite12hInputTokens = if (totals.any { it.cacheWrite12hInputTokens == null }) null else totals.sumOf { requireNotNull(it.cacheWrite12hInputTokens) },
            incompleteUsageCalls = totals.sumOf { it.incompleteUsageCalls },
        )
        return AiCostComparison(
            from, to, stored.mapNotNull { it.fetchedAt }.minOrNull(),
            when { stored.isEmpty() -> "not-synced"; !complete -> "incomplete"; else -> "ready" },
            !todayUtc.isBefore(from) && !todayUtc.isAfter(to), combined,
            if (complete) stored.fold(BigDecimal.ZERO) { sum, day -> sum + day.actualUsd } else null,
            dates.map { day -> AiCostComparisonDay(day, byDay[day]?.totals?.toTotals() ?: AiUsageTotals.EMPTY, byDay[day]?.actualUsd) },
        )
    }

    private fun AiModelPriceDbRow.toDomain() = AiModelPrice(
        id = id,
        modelPrefix = modelPrefix,
        serviceTier = serviceTier,
        inputUsdPerMillion = inputUsdPerMillion,
        cachedInputUsdPerMillion = cachedInputUsdPerMillion,
        outputUsdPerMillion = outputUsdPerMillion,
        effectiveFrom = requireNotNull(effectiveFrom),
        note = note,
        cacheWriteInputUsdPerMillion = cacheWriteInputUsdPerMillion,
        cacheWrite12hInputUsdPerMillion = cacheWrite12hInputUsdPerMillion,
    )

    private fun AiUsageTotalsDbRow.toTotals() =
        AiUsageTotals(calls, inputTokens, cachedInputTokens, outputTokens, estimatedUsd, unpricedCalls,
            cacheWriteInputTokens, cacheWrite12hInputTokens, incompleteUsageCalls)
}
