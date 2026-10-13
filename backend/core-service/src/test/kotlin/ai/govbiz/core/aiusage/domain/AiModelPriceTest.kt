package ai.govbiz.core.aiusage.domain

import java.math.BigDecimal
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AiModelPriceTest {
    private val start = LocalDate.of(2026, 10, 1)
    private val luna = price(1, "gpt-5.6-luna", "default", "0.2", "0.02", "1.2")
    private val lunaFast = price(2, "gpt-5.6-luna", "priority", "0.4", "0.04", "2.4")
    private val embedding = price(3, "text-embedding-3-small", "default", "0.02", null, "0")

    @Test
    fun costsSplitCachedFromUncachedInputAndAddOutputPerMillionTokens() {
        // (1,200 - 1,000) × 0.2 + 1,000 × 0.02 + 80 × 1.2 = 40 + 20 + 96 = 156 micro-USD
        val usage = AiModelUsage("gpt-5.6-luna-2026-07-30", "default", 2, 1_200, 1_000, 80, 0, 0)
        assertEquals(BigDecimal("0.0001560000"), luna.costUsd(usage))
        // 캐시 가격이 없으면 입력 가격을 씁니다.
        assertEquals(BigDecimal("0.0000008400"), embedding.costUsd(AiModelUsage("text-embedding-3-small", "default", 1, 42, 0, 0, 0, 0)))
    }

    @Test
    fun cacheWritePriceReproducesTheAuditedOctober12LunaCharge() {
        val auditedPrice = price(19, "gpt-6-luna", "default", "0.1", "0.01", "0.5")
            .copy(cacheWriteInputUsdPerMillion = BigDecimal("0.125"))
        val usage = AiModelUsage("gpt-6-luna", "default", 1, 482_235, 12_036, 32_095, 470_121, 0)

        // 일반 입력은 78개만 남는다. 캐시 쓰기 470,121개에 일반 입력을 다시 더하지 않는다.
        assertEquals(BigDecimal("0.0749407850"), auditedPrice.costUsd(usage))
    }

    @Test
    fun twelveHourWritesUseTheirOwnConfiguredPriceWithoutDoubleCountingInput() {
        // 검증용 임의 가격이다. 공급자의 12시간 캐시 실제 단가를 가정하지 않는다.
        val configuredPrice = price(30, "test-model", "default", "2", "0.2", "5").copy(
            cacheWriteInputUsdPerMillion = BigDecimal("2.5"),
            cacheWrite12hInputUsdPerMillion = BigDecimal("7.5"),
        )
        val usage = AiModelUsage("test-model", "default", 1, 1_000, 100, 10, 200, 300)

        // 400 × 2 + 100 × 0.2 + 200 × 2.5 + 300 × 7.5 + 10 × 5 = 3,620 micro-USD
        assertEquals(BigDecimal("0.0036200000"), configuredPrice.costUsd(usage))
    }

    @Test
    fun unknownCacheWriteCountersKeepTheCostUnknownEvenWhenPricesExist() {
        val configuredPrice = luna.copy(
            cacheWriteInputUsdPerMillion = BigDecimal("0.25"),
            cacheWrite12hInputUsdPerMillion = BigDecimal("0.75"),
        )
        val unreported = AiModelUsage("gpt-5.6-luna", "default", 1, 100, 10, 5)

        assertNull(configuredPrice.costUsd(unreported))
        assertNull(configuredPrice.costUsd(unreported.copy(cacheWriteInputTokens = 0)))
        assertNull(configuredPrice.costUsd(unreported.copy(cacheWrite12hInputTokens = 0)))
    }

    @Test
    fun positiveCacheWritesNeedTheCorrespondingPrice() {
        val ordinaryWrites = AiModelUsage("gpt-5.6-luna", "default", 1, 100, 0, 0, 100, 0)
        val twelveHourWrites = ordinaryWrites.copy(cacheWriteInputTokens = 0, cacheWrite12hInputTokens = 100)

        assertNull(luna.costUsd(ordinaryWrites))
        assertNull(luna.costUsd(twelveHourWrites))
        assertNull(luna.copy(cacheWriteInputUsdPerMillion = BigDecimal("0.25")).costUsd(twelveHourWrites))
        assertNull(luna.copy(cacheWrite12hInputUsdPerMillion = BigDecimal("0.75")).costUsd(ordinaryWrites))
    }

    @Test
    fun knownZeroWritesDoNotRequireCacheWritePrices() {
        val usage = AiModelUsage("gpt-5.6-luna", "default", 1, 100, 0, 0, 0, 0)

        assertEquals(BigDecimal("0.0000200000"), luna.costUsd(usage))
    }

    @Test
    fun cacheWritesCannotBeNegativeOrExceedTheUncachedInputPartition() {
        for ((writes, writes12h) in listOf<Pair<Long?, Long?>>(
            -1L to 0L,
            0L to -1L,
            71L to 0L,
            0L to 71L,
            40L to 31L,
            null to 71L,
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                AiModelUsage("gpt-6-luna", "default", 1, 100, 30, 0, writes, writes12h)
            }
        }
    }

    @Test
    fun aPriceCoversItsSnapshotsAndTierButNotLookAlikeModels() {
        val prices = listOf(luna, lunaFast, embedding)
        assertEquals(luna, AiModelPrice.find(prices, "gpt-5.6-luna", "default", start))
        assertEquals(lunaFast, AiModelPrice.find(prices, "gpt-5.6-luna-2026-07-30", "priority", start))
        assertNull(AiModelPrice.find(prices, "gpt-5.6-lunar", "default", start))
        assertNull(AiModelPrice.find(prices, "gpt-5.6-luna", "flex", start))
        // 시작일 전에는 쓰지 않습니다.
        assertNull(AiModelPrice.find(prices, "gpt-5.6-luna", "default", start.minusDays(1)))
    }

    @Test
    fun theLongestPrefixThenTheLatestStartWins() {
        val family = price(4, "gpt-6", "default", "9", null, "9")
        val newer = price(5, "gpt-6-luna", "default", "0.15", "0.015", "0.6", start.plusDays(10))
        val prices = listOf(family, price(6, "gpt-6-luna", "default", "0.1", "0.01", "0.5"), newer)
        assertEquals(6L, AiModelPrice.find(prices, "gpt-6-luna-2026-09-03", "default", start.plusDays(9))?.id)
        assertEquals(5L, AiModelPrice.find(prices, "gpt-6-luna-2026-09-03", "default", start.plusDays(10))?.id)
        assertEquals(4L, AiModelPrice.find(prices, "gpt-6-sol", "default", start)?.id)
    }

    @Test
    fun usageAndNewPricesRejectImpossibleValues() {
        assertThrows(IllegalArgumentException::class.java) { AiModelUsage("gpt-5-nano", "default", 1, 10, 11, 0) }
        assertThrows(IllegalArgumentException::class.java) { AiModelUsage("gpt-5-nano", "default", 0, 10, 0, 0) }
        assertThrows(IllegalArgumentException::class.java) { AiModelUsage("gpt 5", "default", 1, 10, 0, 0) }
        assertThrows(IllegalArgumentException::class.java) {
            NewAiModelPrice("gpt-5-nano", "scale", BigDecimal.ONE, null, BigDecimal.ONE, start, null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAiModelPrice("GPT-5", "default", BigDecimal.ONE, null, BigDecimal.ONE, start, null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAiModelPrice("gpt-5-nano", "default", BigDecimal("-1"), null, BigDecimal.ONE, start, null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAiModelPrice("gpt-6-luna", "default", BigDecimal.ONE, null, BigDecimal.ONE, start, null,
                cacheWriteInputUsdPerMillion = BigDecimal("-0.1"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAiModelPrice("gpt-6-luna", "default", BigDecimal.ONE, null, BigDecimal.ONE, start, null,
                cacheWrite12hInputUsdPerMillion = BigDecimal("1000000"))
        }
    }

    private fun price(id: Long, prefix: String, tier: String, input: String, cached: String?, output: String, from: LocalDate = start) =
        AiModelPrice(id, prefix, tier, BigDecimal(input), cached?.let(::BigDecimal), BigDecimal(output), from, null)
}
