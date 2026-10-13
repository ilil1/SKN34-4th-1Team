package ai.govbiz.core.aiusage.config

import ai.govbiz.core._common.helper.validateHttpBaseUrl
import ai.govbiz.core._common.helper.validatePositiveDuration
import java.math.BigDecimal
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * OpenAI 조직 사용량과 실제 비용을 함께 가져오는 설정입니다. 조직 관리자 키([openaiAdminKey], `OPENAI_ADMIN_KEY`)가 있을 때만 Usage·Costs API를 부르며,
 * 프로젝트 키(`sk-proj-…`)로는 가져올 수 없습니다. [openaiProjectId]를 적으면 그 프로젝트 비용만 가져옵니다.
 * [krwPerUsd]는 화면에 원화를 함께 보이는 운영자 입력 환율이며, 비우면 USD만 보입니다.
 */
@ConfigurationProperties(prefix = "app.ai-cost")
data class AiCostProperties(
    val openaiAdminKey: String = "",
    val openaiProjectId: String = "",
    val openaiBaseUrl: URI = URI.create("https://api.openai.com"),
    val syncDays: Long = 35,
    val krwPerUsd: BigDecimal? = null,
    val connectTimeout: Duration = Duration.ofSeconds(5),
    val readTimeout: Duration = Duration.ofSeconds(30),
) {
    init {
        validateHttpBaseUrl(openaiBaseUrl, "app.ai-cost.openai-base-url")
        validatePositiveDuration(connectTimeout, "app.ai-cost.connect-timeout")
        validatePositiveDuration(readTimeout, "app.ai-cost.read-timeout")
        require(syncDays in 1..180) { "app.ai-cost.sync-days must be between 1 and 180" }
        require(krwPerUsd == null || krwPerUsd.signum() > 0) { "app.ai-cost.krw-per-usd must be positive" }
    }

    val adminKeyConfigured: Boolean
        get() = openaiAdminKey.isNotBlank()

    override fun toString(): String = "AiCostProperties(adminKeyConfigured=$adminKeyConfigured, openaiProjectId=$openaiProjectId)"
}
