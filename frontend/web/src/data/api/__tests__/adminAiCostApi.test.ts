import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminAiCostRepositoryImpl } from '../../repositories/AdminAiCostRepositoryImpl'
import { AddAdminAiModelPriceUseCase, GetAdminAiCostSummaryUseCase } from '../../../domain/usecases/AdminAiCostUseCases'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const totals = { calls: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimatedUsd: '0.000008', unpricedCalls: 0 }
const summaryDto = {
  from: '2026-10-01', to: '2026-10-01', totals, actualUsd: null, actualConfigured: false, actualFetchedAt: null, krwPerUsd: null,
  byFeature: [{ key: null, serviceTier: null, totals }], byModel: [{ key: 'gpt-5-nano', serviceTier: 'default', totals }],
  days: [{ date: '2026-10-01', estimatedUsd: '0.000008', calls: 1, actualUsd: null }], topAccounts: [],
}

describe('AdminAiCostRepositoryImpl', () => {
  it('reads the period summary with the session cookie and maps sync refusals to outcomes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(summaryDto))
      .mockResolvedValueOnce(jsonResponse({ code: 'OPENAI_ADMIN_KEY_MISSING' }, 503))
      .mockResolvedValueOnce(jsonResponse({ code: 'OPENAI_ADMIN_KEY_REJECTED' }, 502))
      .mockResolvedValueOnce(jsonResponse({ from: '2026-09-06', to: '2026-10-10', lines: 3, amountUsd: '1.250000' }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new AdminAiCostRepositoryImpl()

    const summary = await repository.getSummary('2026-10-01', '2026-10-01')
    expect(summary.byFeature[0]!.key).toBeNull()
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/admin/ai-costs?from=2026-10-01&to=2026-10-01')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    await expect(repository.sync()).resolves.toEqual({ outcome: 'admin-key-missing' })
    await expect(repository.sync()).resolves.toEqual({ outcome: 'admin-key-rejected' })
    await expect(repository.sync()).resolves.toEqual({ outcome: 'done', lines: 3, amountUsd: '1.250000' })
  })

  it('adds a price and reports duplicates and invalid values as outcomes', async () => {
    const created = { id: 9, modelPrefix: 'gpt-6-luna', serviceTier: 'flex', inputUsdPerMillion: '0.05', cachedInputUsdPerMillion: null,
      cacheWriteInputUsdPerMillion: '0.0625', cacheWrite12hInputUsdPerMillion: null,
      outputUsdPerMillion: '0.25', effectiveFrom: '2026-11-01', note: null }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse({ code: 'AI_MODEL_PRICE_CONFLICT' }, 409))
      .mockResolvedValueOnce(jsonResponse({ code: 'AI_COST_REQUEST_INVALID' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    const useCase = new AddAdminAiModelPriceUseCase(new AdminAiCostRepositoryImpl())
    const input = { modelPrefix: ' GPT-6-Luna ', serviceTier: 'flex' as const, inputUsdPerMillion: '0.05', cachedInputUsdPerMillion: ' ',
      cacheWriteInputUsdPerMillion: ' 0.0625 ', cacheWrite12hInputUsdPerMillion: ' ',
      outputUsdPerMillion: '0.25', effectiveFrom: '2026-11-01', note: '  ' }

    await expect(useCase.execute(input)).resolves.toEqual({ outcome: 'done', price: created })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      modelPrefix: 'gpt-6-luna', serviceTier: 'flex', inputUsdPerMillion: '0.05', cachedInputUsdPerMillion: null,
      cacheWriteInputUsdPerMillion: '0.0625', cacheWrite12hInputUsdPerMillion: null,
      outputUsdPerMillion: '0.25', effectiveFrom: '2026-11-01', note: null,
    })
    await expect(useCase.execute(input)).resolves.toEqual({ outcome: 'conflict' })
    await expect(useCase.execute(input)).resolves.toEqual({ outcome: 'invalid' })
  })

  it('refuses reversed, malformed and too long periods before calling the server', () => {
    const useCase = new GetAdminAiCostSummaryUseCase({ getSummary: vi.fn() })
    expect(() => useCase.execute('2026-10-10', '2026-10-01')).toThrow('reversed-period')
    expect(() => useCase.execute('2026-1-1', '2026-10-01')).toThrow('invalid-date')
    expect(() => useCase.execute('2026-01-01', '2026-10-01')).toThrow('too-long')
  })
})
