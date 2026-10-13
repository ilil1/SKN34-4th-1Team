import { planUsageFeatureLabels } from './PlanUsage'

/** AI 비용을 나눠 보는 기능입니다. null은 로그인 전 요청이나 시스템 작업(색인·조건 정리·공고 분석)입니다. */
export type AiUsageFeature =
  | 'AI_SEARCH'
  | 'EVIDENCE_QUESTION'
  | 'APPLICATION_DRAFT'
  | 'COMBINATION_REVIEW'
  | 'ASSISTANT'
  | 'DAILY_REPORT'
  | 'SAVED_PROGRAM_PREFETCH'
  | 'GOV_AGENT'

/** 응답의 처리 등급입니다. Fast 모드는 응답에서 priority로 옵니다. */
export type AiServiceTier = 'default' | 'priority' | 'flex'

/** 기간 합계입니다. 금액은 소수 6자리 USD이고 비용 미확정 호출은 제외됩니다. null인 쓰기 토큰은 미확인이며 0이 아닙니다. */
export type AiUsageTotals = {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number | null
  cacheWrite12hInputTokens: number | null
  outputTokens: number
  estimatedUsd: string
  unpricedCalls: number
  incompleteUsageCalls: number
}

/** 같은 조회에서 수집한 OpenAI 사용량·비용입니다. ready여도 제공처의 지연 집계로 이후 금액이 달라질 수 있습니다. */
export type AdminAiCostComparison = {
  timezone: 'UTC'
  from: string
  to: string
  fetchedAt: string | null
  status: 'not-synced' | 'incomplete' | 'ready'
  includesCurrentDay: boolean
  totals: AiUsageTotals | null
  actualUsd: string | null
  days: { date: string; totals: AiUsageTotals; actualUsd: string | null }[]
}

/**
 * 관리자 AI 비용 화면의 UTC 기간입니다. totals·그룹은 앱이 직접 기록한 사용량이며, 비교에는 comparison만 사용합니다.
 * comparison이 없으면 이전 서버 응답입니다. actualConfigured는 조직 관리자 키 설정 여부, krwPerUsd는 운영자 환율입니다.
 */
export type AdminAiCostSummary = {
  from: string
  to: string
  totals: AiUsageTotals
  actualUsd: string | null
  actualConfigured: boolean
  actualFetchedAt: string | null
  krwPerUsd: string | null
  comparison: AdminAiCostComparison | null
  byFeature: { key: string | null; totals: AiUsageTotals }[]
  byModel: { key: string; serviceTier: string; totals: AiUsageTotals }[]
  days: { date: string; estimatedUsd: string; calls: number; actualUsd: string | null }[]
  topAccounts: { accountId: number; email: string; planCode: string | null; totals: AiUsageTotals }[]
}

/** 1M 토큰당 USD 가격입니다. 캐시 읽기 가격은 입력 가격으로 보완하지만 쓰기 가격이 없으면 쓰기 비용을 확정하지 않습니다. */
export type AdminAiModelPrice = {
  id: number
  modelPrefix: string
  serviceTier: AiServiceTier
  inputUsdPerMillion: string
  cachedInputUsdPerMillion: string | null
  cacheWriteInputUsdPerMillion: string | null
  cacheWrite12hInputUsdPerMillion: string | null
  outputUsdPerMillion: string
  effectiveFrom: string
  note: string | null
}

export type NewAdminAiModelPrice = Omit<AdminAiModelPrice, 'id'>

/** 한 번에 보는 최대 기간(일)입니다. 서버와 같습니다. */
export const adminAiCostMaxDays = 92

export const aiUsageFeatureLabels: Record<AiUsageFeature, string> = {
  ...planUsageFeatureLabels,
  ASSISTANT: '도우미',
  DAILY_REPORT: '맞춤 리포트',
  SAVED_PROGRAM_PREFETCH: '관심 공고 준비',
  GOV_AGENT: 'Gov 에이전트',
}

export const aiServiceTierLabels: Record<AiServiceTier, string> = { default: '기본', priority: 'Fast(priority)', flex: 'Flex' }

/** 기능 키의 이름입니다. 모르는 값은 그대로, 없으면 시스템·기타입니다. */
export function aiUsageFeatureLabel(key: string | null): string {
  if (key === null) return '시스템·기타(색인·조건 정리·공고 분석)'
  return key in aiUsageFeatureLabels ? aiUsageFeatureLabels[key as AiUsageFeature] : key
}

/** `0.012346` → `$0.012346`, 환율이 있으면 `$0.012346 (약 17원)`입니다. */
export function formatAiCostUsd(usd: string, krwPerUsd: string | null = null): string {
  if (krwPerUsd === null) return `$${usd}`
  const won = Math.round(Number(usd) * Number(krwPerUsd))
  return `$${usd} (약 ${won.toLocaleString('ko-KR')}원)`
}

/** UTC 기준 이번 달 1일부터 오늘까지입니다. */
export function defaultAdminAiCostPeriod(now: number = Date.now()): { from: string; to: string } {
  const today = new Date(now).toISOString().slice(0, 10)
  return { from: `${today.slice(0, 8)}01`, to: today }
}
