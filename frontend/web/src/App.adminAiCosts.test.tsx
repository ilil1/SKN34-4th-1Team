// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { appContainer } from './app/appContainer'
import { createAppStore } from './app/store'
import type { Account } from './domain/entities/Account'
import type { AdminAiCostComparison, AdminAiCostSummary, AdminAiModelPrice } from './domain/entities/AdminAiCost'
import { adminAiCostMessages } from './presentation/features/admin/viewmodel/useAdminAiCostViewModel'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({
  CoreApiConnectionStatus: () => null,
}))

const adminAccount: Account = { email: 'admin@govbiz.local', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, company: null, accountType: null, onboarded: true }
const totals = { calls: 12, inputTokens: 50_000, cachedInputTokens: 30_000, cacheWriteInputTokens: 10_000, cacheWrite12hInputTokens: 0,
  outputTokens: 4_000, estimatedUsd: '0.012346', unpricedCalls: 0, incompleteUsageCalls: 0 }

function comparisonOf(overrides: Partial<AdminAiCostComparison> = {}): AdminAiCostComparison {
  return {
    timezone: 'UTC', from: '2026-10-01', to: '2026-10-10', fetchedAt: '2026-10-10T03:00:00Z', status: 'ready',
    includesCurrentDay: true, totals: { ...totals, calls: 30, estimatedUsd: '0.015000' }, actualUsd: '0.020000',
    days: [
      { date: '2026-10-09', totals: { ...totals, calls: 0, estimatedUsd: '0.000000' }, actualUsd: null },
      { date: '2026-10-07', totals: { ...totals, calls: 1, estimatedUsd: '0.000001' }, actualUsd: null },
      { date: '2026-10-10', totals, actualUsd: '0.020000' },
      { date: '2026-10-08', totals: { ...totals, calls: 0, estimatedUsd: '0.000000' }, actualUsd: '0.000002' },
    ],
    ...overrides,
  }
}

function summaryOf(overrides: Partial<AdminAiCostSummary> = {}): AdminAiCostSummary {
  return {
    from: '2026-10-01',
    to: '2026-10-10',
    totals,
    actualUsd: null,
    actualConfigured: false,
    actualFetchedAt: null,
    krwPerUsd: null,
    comparison: null,
    byFeature: [{ key: 'AI_SEARCH', totals }, { key: null, totals: { ...totals, calls: 3, estimatedUsd: '0.000060' } }],
    byModel: [{ key: 'gpt-5.6-sol-2026-07-30', serviceTier: 'priority', totals }],
    days: [
      { date: '2026-10-09', estimatedUsd: '0.000000', calls: 0, actualUsd: null },
      { date: '2026-10-07', estimatedUsd: '0.000001', calls: 1, actualUsd: null },
      { date: '2026-10-10', estimatedUsd: '0.012346', calls: 12, actualUsd: null },
      { date: '2026-10-08', estimatedUsd: '0.000000', calls: 0, actualUsd: '0.000002' },
    ],
    topAccounts: [{ accountId: 11, email: 'member@company.co.kr', planCode: 'PLUS', totals }],
    ...overrides,
  }
}

const price: AdminAiModelPrice = {
  id: 1, modelPrefix: 'gpt-5.6-luna', serviceTier: 'default', inputUsdPerMillion: '0.2', cachedInputUsdPerMillion: '0.02',
  cacheWriteInputUsdPerMillion: '0.25', cacheWrite12hInputUsdPerMillion: null,
  outputUsdPerMillion: '1.2', effectiveFrom: '2026-10-01', note: '공식 가격',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T03:00:00Z'))
  vi.spyOn(appContainer.resolve('getAdminAiModelPricesUseCase'), 'execute').mockResolvedValue([price])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderApp() {
  const store = createAppStore()
  store.dispatch(sessionRestored(adminAccount))
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/app/admin/ai-costs']}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('관리자 AI 비용', () => {
  it('이번 달 추정 비용을 기능·모델·날짜·회원별로 보이고, 관리자 키가 없으면 실제 비용 대신 까닭을 보인다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf())
    renderApp()

    const stats = await screen.findByRole('region', { name: '비용 요약' })
    expect(getSummary).toHaveBeenCalledWith('2026-10-01', '2026-10-10', expect.any(AbortSignal))
    expect(within(stats).queryByText('$0.012346')).toBeNull()
    expect(within(screen.getByRole('region', { name: '앱 사용량 요약' })).getByText('$0.012346')).toBeTruthy()
    expect(screen.getByText(adminAiCostMessages.actualMissingKey)).toBeTruthy()
    expect((screen.getByRole('button', { name: '사용량·비용 가져오기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(screen.getByRole('region', { name: '기능별' })).getByText('AI 대화 검색')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '기능별' })).getByText('시스템·기타(색인·조건 정리·공고 분석)')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '모델별' })).getByText('Fast(priority)')).toBeTruthy()
    // 앱 기록과 이전 실제 비용으로 날짜별 비교를 만들지 않습니다.
    const days = within(screen.getByRole('region', { name: '날짜별' }))
    expect(days.queryByText('2026-10-09')).toBeNull()
    expect(days.getByText('이 기간에 함께 가져온 사용량·비용이 없어요.')).toBeTruthy()
    const member = within(screen.getByRole('region', { name: '많이 쓴 회원' })).getByRole('link', { name: 'member@company.co.kr' })
    expect(member.getAttribute('href')).toBe('/app/admin/accounts/detail?accountId=11')
    expect(within(screen.getByRole('region', { name: '가격표' })).getByText('gpt-5.6-luna')).toBeTruthy()
    // 사이드바 메뉴는 잠시 숨겨 주소로만 엽니다.
    expect(screen.queryByRole('link', { name: 'AI 비용' })).toBeNull()
  })

  it('관리자 키가 있으면 실제 비용을 가져와 다시 읽고, 원화 환율이 있으면 함께 보인다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute')
      .mockResolvedValueOnce(summaryOf({ actualConfigured: true }))
      .mockResolvedValueOnce(summaryOf({ actualConfigured: true, actualUsd: '9.000000', actualFetchedAt: '2026-10-10T12:00:00', krwPerUsd: '1400', comparison: comparisonOf() }))
    const sync = vi.spyOn(appContainer.resolve('syncAdminAiCostsUseCase'), 'execute').mockResolvedValue({ outcome: 'done', lines: 4, amountUsd: '0.020000' })
    renderApp()

    await screen.findByRole('region', { name: '비용 요약' })
    expect(screen.getByText(adminAiCostMessages.actualNeverFetched)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '사용량·비용 가져오기' }))

    await waitFor(() => expect(sync).toHaveBeenCalled())
    expect(await screen.findByText(adminAiCostMessages.sync.done(4, '0.020000'))).toBeTruthy()
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(2))
    const updated = await screen.findByText('$0.020000 (약 28원)')
    expect(updated).toBeTruthy()
    const stats = within(screen.getByRole('region', { name: '비용 요약' }))
    expect(stats.getByText('+$0.005000')).toBeTruthy()
    expect(stats.getByText('30회')).toBeTruthy()
    expect(stats.getByText('2026-10-10 03:00 UTC 함께 가져옴')).toBeTruthy()
    expect(screen.queryByText('$9.000000')).toBeNull()
    expect(screen.getByText(adminAiCostMessages.currentDay)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '날짜별' })).getAllByRole('row').slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual(['2026-10-10', '2026-10-08', '2026-10-07'])
  })

  it('거꾸로 된 기간은 보내지 않고, 가격은 새 행으로 더한다', async () => {
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf())
    const addPrice = vi.spyOn(appContainer.resolve('addAdminAiModelPriceUseCase'), 'execute')
      .mockResolvedValueOnce({ outcome: 'conflict' })
      .mockResolvedValueOnce({ outcome: 'done', price: { ...price, id: 2, modelPrefix: 'gpt-6-luna', effectiveFrom: '2026-11-01', note: null } })
    renderApp()
    await screen.findByRole('region', { name: '비용 요약' })

    fireEvent.change(screen.getByLabelText('시작일', { selector: 'input[name="from"]' }), { target: { value: '2026-10-20' } })
    fireEvent.click(screen.getByRole('button', { name: '조회' }))
    expect(screen.getByText(adminAiCostMessages.period['reversed-period'])).toBeTruthy()
    expect(getSummary).toHaveBeenCalledTimes(1)

    const form = screen.getByRole('form', { name: '가격 추가' })
    fireEvent.change(within(form).getByLabelText('모델'), { target: { value: 'gpt-6-luna' } })
    fireEvent.change(within(form).getByLabelText('입력'), { target: { value: '0.1' } })
    fireEvent.change(within(form).getByLabelText('출력'), { target: { value: '0.5' } })
    fireEvent.change(within(form).getByLabelText('캐시 쓰기'), { target: { value: '0.125' } })
    fireEvent.change(within(form).getByLabelText('12시간 캐시 쓰기'), { target: { value: '0.2' } })
    fireEvent.change(within(form).getByLabelText('시작일'), { target: { value: '2026-11-01' } })
    fireEvent.click(within(form).getByRole('button', { name: '가격 추가' }))
    expect(await screen.findByText(adminAiCostMessages.price.conflict)).toBeTruthy()

    fireEvent.click(within(form).getByRole('button', { name: '가격 추가' }))
    expect(await screen.findByText(adminAiCostMessages.price.added)).toBeTruthy()
    expect(addPrice).toHaveBeenLastCalledWith({
      modelPrefix: 'gpt-6-luna', serviceTier: 'default', inputUsdPerMillion: '0.1', cachedInputUsdPerMillion: null,
      cacheWriteInputUsdPerMillion: '0.125', cacheWrite12hInputUsdPerMillion: '0.2',
      outputUsdPerMillion: '0.5', effectiveFrom: '2026-11-01', note: '',
    })
    expect(within(screen.getByRole('region', { name: '가격표' })).getByText('gpt-6-luna')).toBeTruthy()
  })

  it.each([
    ['미수집 날짜', comparisonOf({ status: 'incomplete' }), adminAiCostMessages.comparisonIncomplete],
    ['가격 미등록', comparisonOf({ totals: { ...totals, unpricedCalls: 1 } }), adminAiCostMessages.comparisonUnpriced],
    ['사용량 미확인', comparisonOf({ totals: { ...totals, incompleteUsageCalls: 1, cacheWriteInputTokens: null } }), adminAiCostMessages.comparisonUnpriced],
  ] as const)('%s가 있으면 차이를 숨기고 사유를 보여 준다', async (_name, comparison, message) => {
    vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf({ actualConfigured: true, comparison }))
    renderApp()
    const stats = within(await screen.findByRole('region', { name: '비용 요약' }))
    expect(stats.queryByText(/^\+\$/)).toBeNull()
    expect(screen.getByText(message)).toBeTruthy()
  })

  it('서울 날짜가 다음 달이어도 UTC 기간으로 조회한다', async () => {
    vi.setSystemTime(new Date('2026-11-01T01:00:00+09:00'))
    const getSummary = vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf())
    renderApp()
    await screen.findByRole('region', { name: '비용 요약' })
    expect(getSummary).toHaveBeenCalledWith('2026-10-01', '2026-10-31', expect.any(AbortSignal))
  })

  it('비용 미확정 호출은 요약·기능·모델·회원별로 0원으로 표시하지 않고 제외 건수를 명시한다', async () => {
    const unknown = { ...totals, unpricedCalls: totals.calls, estimatedUsd: '0.000000' }
    const partial = { ...totals, unpricedCalls: 1 }
    vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf({
      actualConfigured: true,
      totals: unknown,
      comparison: comparisonOf({ totals: unknown }),
      byFeature: [{ key: 'AI_SEARCH', totals: unknown }],
      byModel: [
        { key: 'gpt-6-luna', serviceTier: 'default', totals: unknown },
        { key: 'gpt-5-nano', serviceTier: 'default', totals: partial },
      ],
      topAccounts: [
        { accountId: 11, email: 'unknown@example.com', planCode: 'PLUS', totals: unknown },
        { accountId: 12, email: 'partial@example.com', planCode: 'PLUS', totals: partial },
      ],
    }))
    renderApp()
    const stats = within(await screen.findByRole('region', { name: '비용 요약' }))
    expect(stats.getByText('미확정')).toBeTruthy()
    expect(stats.queryByText('$0.000000')).toBeNull()
    expect(within(screen.getByRole('region', { name: '앱 사용량 요약' })).getByText('미확정')).toBeTruthy()
    for (const name of ['기능별', '모델별', '많이 쓴 회원']) {
      const section = within(screen.getByRole('region', { name }))
      expect(section.getByText('미확정 · 비용 미확정 호출 12회 제외')).toBeTruthy()
      expect(section.queryByText('$0.000000')).toBeNull()
    }
    for (const name of ['모델별', '많이 쓴 회원']) {
      expect(within(screen.getByRole('region', { name })).getByText('$0.012346 · 비용 미확정 호출 1회 제외')).toBeTruthy()
    }
  })

  it('미수집 날짜의 빈 합계를 0원 일별 비용으로 표시하지 않는다', async () => {
    vi.spyOn(appContainer.resolve('getAdminAiCostSummaryUseCase'), 'execute').mockResolvedValue(summaryOf({
      actualConfigured: true,
      comparison: comparisonOf({ status: 'incomplete', totals: null, actualUsd: null, days: [
        { date: '2026-10-09', totals: { ...totals, calls: 0, estimatedUsd: '0.000000' }, actualUsd: null },
      ] }),
    }))
    renderApp()
    const days = within(await screen.findByRole('region', { name: '날짜별' }))
    expect(days.queryByText('2026-10-09')).toBeNull()
    expect(days.queryByText('$0.000000')).toBeNull()
    expect(screen.getByText(adminAiCostMessages.comparisonIncomplete)).toBeTruthy()
  })
})
