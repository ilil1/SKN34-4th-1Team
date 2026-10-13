import { describe, expect, it } from 'vitest'

import { adminAiCostSummaryDtoSchema, adminAiModelPriceDtoSchema, toAdminAiCostSummary } from './AdminAiCostDto'

const totals = { calls: 1, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, estimatedUsd: '0.000015', unpricedCalls: 0 }
const legacy = {
  from: '2026-10-12', to: '2026-10-13', totals, actualUsd: '0.001000', actualConfigured: true,
  actualFetchedAt: '2026-10-14T01:49:00', krwPerUsd: null, byFeature: [], byModel: [], days: [], topAccounts: [],
}
const providerTotals = { ...totals, cacheWriteInputTokens: 50, cacheWrite12hInputTokens: 10, incompleteUsageCalls: 0 }
const comparison = {
  timezone: 'UTC', from: '2026-10-12', to: '2026-10-13', fetchedAt: '2026-10-13T17:00:00Z', status: 'ready',
  includesCurrentDay: false, totals: providerTotals, actualUsd: '0.000020',
  days: [{ date: '2026-10-13', totals: providerTotals, actualUsd: '0.000020' }],
}

describe('AdminAiCostDto', () => {
  it('이전 응답의 캐시 쓰기를 0으로 바꾸거나 서로 다른 장부로 비교를 만들지 않는다', () => {
    const value = toAdminAiCostSummary(adminAiCostSummaryDtoSchema.parse(legacy))
    expect(value.comparison).toBeNull()
    expect(value.totals.cacheWriteInputTokens).toBeNull()
    expect(value.totals.cacheWrite12hInputTokens).toBeNull()
  })

  it('제공처 스냅샷과 캐시 쓰기를 읽고 중첩된 응답 객체를 복사한다', () => {
    const dto = adminAiCostSummaryDtoSchema.parse({ ...legacy, comparison })
    const value = toAdminAiCostSummary(dto)
    expect(value.comparison).toEqual(comparison)
    expect(value.comparison?.totals).not.toBe(dto.comparison?.totals)
    expect(value.comparison?.days[0]?.totals).not.toBe(dto.comparison?.days[0]?.totals)
    expect(value.actualUsd).toBe('0.001000')
    expect(value.comparison?.actualUsd).toBe('0.000020')
  })

  it.each([
    { ...comparison, timezone: 'Asia/Seoul' },
    { ...comparison, fetchedAt: '2026-10-14T02:00:00' },
    { ...comparison, status: 'final' },
    { ...comparison, totals: { ...providerTotals, cacheWriteInputTokens: -1 } },
    { ...comparison, totals: { ...providerTotals, incompleteUsageCalls: 0.5 } },
  ])('잘못된 비교 시간대·상태·토큰을 거절한다', (invalid) => {
    expect(adminAiCostSummaryDtoSchema.safeParse({ ...legacy, comparison: invalid }).success).toBe(false)
  })

  it('등록되지 않은 쓰기 단가는 null이며 0원 가격과 구분한다', () => {
    const price = { id: 1, modelPrefix: 'gpt-6-luna', serviceTier: 'default', inputUsdPerMillion: '0.1',
      cachedInputUsdPerMillion: '0.01', outputUsdPerMillion: '0.5', effectiveFrom: '2026-10-01', note: null }
    expect(adminAiModelPriceDtoSchema.parse(price).cacheWriteInputUsdPerMillion).toBeNull()
    expect(adminAiModelPriceDtoSchema.parse({ ...price, cacheWriteInputUsdPerMillion: '0' }).cacheWriteInputUsdPerMillion).toBe('0')
  })
})
