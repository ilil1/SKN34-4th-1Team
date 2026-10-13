package ai.govbiz.core.aiusage.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.web.AdminPrincipalArgumentResolver
import ai.govbiz.core.aiusage.domain.AiCostSummary
import ai.govbiz.core.aiusage.domain.AiCostDay
import ai.govbiz.core.aiusage.domain.AiCostComparison
import ai.govbiz.core.aiusage.domain.AiCostComparisonDay
import ai.govbiz.core.aiusage.domain.AiModelPrice
import ai.govbiz.core.aiusage.domain.NewAiModelPrice
import ai.govbiz.core.aiusage.domain.AiUsageAccount
import ai.govbiz.core.aiusage.domain.AiUsageGroup
import ai.govbiz.core.aiusage.domain.AiUsageTotals
import ai.govbiz.core.aiusage.service.AiCostSyncService
import ai.govbiz.core.aiusage.service.AiUsageService
import ai.govbiz.core.aiusage.service.exception.AiCostSyncException
import ai.govbiz.core.aiusage.service.exception.AiModelPriceConflictException
import jakarta.servlet.http.Cookie
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.ArgumentCaptor
import org.mockito.Mockito
import org.mockito.Mockito.any
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AdminAiCostControllerTest {
    @Mock private lateinit var sessions: AccountSessionService
    @Mock private lateinit var usage: AiUsageService
    @Mock private lateinit var costs: AiCostSyncService
    private lateinit var mvc: MockMvc
    private val admin = AccountTestHelper.account(id = 1, email = "admin@govbiz.local", role = AccountRole.ADMIN)
    private val actor = AdminActor(1, "198.51.100.7", "Mozilla/5.0")

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(AdminAiCostController(usage, costs))
            .setCustomArgumentResolvers(AdminPrincipalArgumentResolver { sessions })
            .setControllerAdvice(ApiExceptionHandler()).build()
        doReturn(admin).`when`(sessions).requireAccount(SESSION)
    }

    @Test
    fun summaryShowsEstimatedAndActualCostsAsExactUsdStrings() {
        val from = LocalDate.of(2026, 10, 1)
        val totals = AiUsageTotals(12, 50_000, 30_000, 4_000, BigDecimal("0.0123456789"), 2)
        val organizationTotals = AiUsageTotals(122, 706_873, 30_000, 4_000, BigDecimal("0.0254831389"), 0, 400, 200, 0)
        doReturn(
            AiCostSummary(
                from, from, totals, BigDecimal("0.02"), true, null, BigDecimal("1380"),
                listOf(AiUsageGroup("AI_SEARCH", null, totals), AiUsageGroup(null, null, AiUsageTotals.EMPTY)),
                listOf(AiUsageGroup("gpt-5.6-sol-2026-07-30", "priority", totals)),
                listOf(AiCostDay(from, BigDecimal("0.0123456789"), 12, null)),
                listOf(AiUsageAccount(7, "member@company.co.kr", "PLUS", totals)),
                AiCostComparison(
                    from, from, LocalDateTime.of(2026, 10, 2, 1, 2, 3), "ready", false,
                    organizationTotals, BigDecimal("0.0255"),
                    listOf(AiCostComparisonDay(from, organizationTotals, BigDecimal("0.0255"))),
                ),
            ),
        ).`when`(usage).summary(actor, from, from)

        mvc.perform(asAdmin(get("$PATH?from=2026-10-01&to=2026-10-01")))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.totals.estimatedUsd").value("0.012346"))
            .andExpect(jsonPath("$.totals.unpricedCalls").value(2))
            .andExpect(jsonPath("$.actualUsd").value("0.020000"))
            .andExpect(jsonPath("$.krwPerUsd").value("1380"))
            .andExpect(jsonPath("$.byFeature[1].key").doesNotExist())
            .andExpect(jsonPath("$.byModel[0].serviceTier").value("priority"))
            .andExpect(jsonPath("$.days[0].actualUsd").doesNotExist())
            .andExpect(jsonPath("$.topAccounts[0].email").value("member@company.co.kr"))
            .andExpect(jsonPath("$.comparison.timezone").value("UTC"))
            .andExpect(jsonPath("$.comparison.fetchedAt").value("2026-10-02T01:02:03Z"))
            .andExpect(jsonPath("$.comparison.status").value("ready"))
            .andExpect(jsonPath("$.comparison.includesCurrentDay").value(false))
            .andExpect(jsonPath("$.comparison.totals.calls").value(122))
            .andExpect(jsonPath("$.comparison.totals.estimatedUsd").value("0.025483"))
            .andExpect(jsonPath("$.comparison.totals.cacheWriteInputTokens").value(400))
            .andExpect(jsonPath("$.comparison.totals.cacheWrite12hInputTokens").value(200))
            .andExpect(jsonPath("$.comparison.totals.incompleteUsageCalls").value(0))
            .andExpect(jsonPath("$.comparison.actualUsd").value("0.025500"))
            .andExpect(jsonPath("$.comparison.days[0].date").value("2026-10-01"))
            .andExpect(jsonPath("$.comparison.days[0].totals.calls").value(122))
            .andExpect(jsonPath("$.comparison.days[0].actualUsd").value("0.025500"))
    }

    @Test
    fun anUnavailableComparisonDoesNotSerializeMissingUsageAsZero() {
        val from = LocalDate.of(2026, 10, 1)
        val comparison = AiCostComparison(from, from, null, "not-synced", true, null, null, emptyList())
        doReturn(
            AiCostSummary(from, from, AiUsageTotals.EMPTY, null, true, null, null, emptyList(), emptyList(), emptyList(), emptyList(), comparison),
        ).`when`(usage).summary(actor, from, from)

        mvc.perform(asAdmin(get("$PATH?from=2026-10-01&to=2026-10-01")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.comparison.status").value("not-synced"))
            .andExpect(jsonPath("$.comparison.includesCurrentDay").value(true))
            .andExpect(jsonPath("$.comparison.totals").doesNotExist())
            .andExpect(jsonPath("$.comparison.actualUsd").doesNotExist())
            .andExpect(jsonPath("$.comparison.fetchedAt").doesNotExist())
            .andExpect(jsonPath("$.comparison.days").isEmpty())
    }

    @Test
    fun priceCreationPreservesBothCacheWriteRatesInRequestAndResponse() {
        val response = AiModelPrice(
            91, "gpt-5.6-luna", "default", BigDecimal("0.2"), null, BigDecimal("1.2"), LocalDate.of(2026, 11, 1), null,
            BigDecimal("0.25"), BigDecimal("0.40"),
        )
        doReturn(response).`when`(usage).addPrice(Mockito.eq(actor) ?: actor, any() ?: price())
        val payload = PRICE.replace("\"outputUsdPerMillion\":1.2", "\"outputUsdPerMillion\":1.2,\"cacheWriteInputUsdPerMillion\":0.25,\"cacheWrite12hInputUsdPerMillion\":0.40")

        mvc.perform(asAdmin(post("$PATH/prices")).contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.cacheWriteInputUsdPerMillion").value("0.25"))
            .andExpect(jsonPath("$.cacheWrite12hInputUsdPerMillion").value("0.4"))

        val captured = ArgumentCaptor.forClass(NewAiModelPrice::class.java)
        Mockito.verify(usage).addPrice(Mockito.eq(actor) ?: actor, captured.capture() ?: price())
        assertEquals(BigDecimal("0.25"), captured.value.cacheWriteInputUsdPerMillion)
        assertEquals(BigDecimal("0.40"), captured.value.cacheWrite12hInputUsdPerMillion)
    }

    @Test
    fun syncFailuresAndPriceConflictsHaveTheirOwnCodes() {
        doThrow(AiCostSyncException(AiCostSyncException.Reason.ADMIN_KEY_MISSING)).`when`(costs).sync()
        mvc.perform(asAdmin(post("$PATH/sync")))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("OPENAI_ADMIN_KEY_MISSING"))

        doThrow(AiModelPriceConflictException()).`when`(usage).addPrice(org.mockito.Mockito.eq(actor) ?: actor, any() ?: price())
        mvc.perform(asAdmin(post("$PATH/prices")).contentType(MediaType.APPLICATION_JSON).content(PRICE))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("AI_MODEL_PRICE_CONFLICT"))
    }

    @Test
    fun badPricesAndPeriodsAreRejectedBeforeTheService() {
        mvc.perform(asAdmin(post("$PATH/prices")).contentType(MediaType.APPLICATION_JSON).content(PRICE.replace(":0.2,", ":-1,")))
            .andExpect(status().isBadRequest())
        mvc.perform(asAdmin(post("$PATH/prices")).contentType(MediaType.APPLICATION_JSON).content(PRICE.replace("\"default\"", "\"scale\"")))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("AI_COST_REQUEST_INVALID"))
        for (field in listOf("cacheWriteInputUsdPerMillion", "cacheWrite12hInputUsdPerMillion")) {
            mvc.perform(asAdmin(post("$PATH/prices")).contentType(MediaType.APPLICATION_JSON)
                .content(PRICE.replace("\"outputUsdPerMillion\":1.2", "\"outputUsdPerMillion\":1.2,\"$field\":-0.01")))
                .andExpect(status().isBadRequest())
        }
        verifyNoInteractions(usage)
    }

    private fun price() = ai.govbiz.core.aiusage.domain.NewAiModelPrice(
        "gpt-5.6-luna", "default", BigDecimal("0.2"), null, BigDecimal("1.2"), LocalDate.of(2026, 11, 1), null,
    )

    private fun asAdmin(request: MockHttpServletRequestBuilder): MockHttpServletRequestBuilder =
        request.cookie(Cookie(SessionCookieHelper.COOKIE_NAME, SESSION))
            .header(HttpHeaders.USER_AGENT, requireNotNull(actor.userAgent))
            .with { it.remoteAddr = actor.clientIp; it }

    private companion object {
        const val PATH = "/api/v1/admin/ai-costs"
        const val SESSION = "admin-session"
        const val PRICE = """{"modelPrefix":"gpt-5.6-luna","serviceTier":"default","inputUsdPerMillion":0.2,"outputUsdPerMillion":1.2,"effectiveFrom":"2026-11-01"}"""
    }
}
