// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import App from './App'
import { appContainer } from './app/appContainer'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { createAppStore } from './app/store'
import { readPendingEvaluation, storePendingEvaluation } from './data/ops/pendingEvaluation'
import { getEvaluation, type EvaluationReview } from './data/ops/opsApi'

const id = '10000000-0000-4000-8000-000000000001'
const flowId = '20000000-0000-4000-8000-000000000002'
const capture = { id: 'target-coverage-20260907-v1', label: '저장 캡처' }
const liveConfig = { model: 'gpt-6-luna', fixture_sha256: 'c'.repeat(64), max_model_calls: 6, max_output_tokens: 2000 }
const executionProfiles = { replay: "d".repeat(64), live: "e".repeat(64) }
const dataset = { evaluation_scope: 'fixed-answer-context-only', execution_profiles: executionProfiles, baseline: null, fixture: 'target-coverage-fixture.json', live_config: liveConfig, id: capture.id, label: '지원 대상 근거 답변 · 저장된 가상 평가 6건', case_ids: ['TC01', 'TC02', 'TC03', 'TC04', 'TC05', 'TC06'], captures: [capture] }
const comparisonDataset = { evaluation_scope: 'fixed-answer-context-only', execution_profiles: executionProfiles, baseline: null, fixture: 'fixture.json', live_config: { ...liveConfig, max_model_calls: 1 }, id: 'fixed-context-e01-v1', label: '공통 E01 비교', case_ids: ['E01'], captures: [{ id: 'reference', label: '기준 프롬프트' }, { id: 'candidate', label: '후보 프롬프트' }] }
const completed = {
  evaluation_scope: 'fixed-answer-context-only',
  execution_mode: 'replay', live_config: null, trace_links: [],
  candidate_capture_id: capture.id, reference_capture_id: capture.id, candidate_label: capture.label, reference_label: capture.label, comparison: null,
  id, dataset_id: dataset.id, dataset_label: dataset.label, requested_by: 'operator@example.com', requested_by_id: 'core:99', can_retry: false,
  status: 'COMPLETED', status_label: '완료', created_at: '2026-09-27T00:00:00Z',
  started_at: null, finished_at: null, synced_at: null, error_code: '', error_message: '',
  summary: { caseCount: 6, observedCaseCount: 6, statusAccuracy: 1, referenceCitationRecall: 1, semanticFaithfulness: null },
  model_api_calls: 0, evaluation_run_id: 'a'.repeat(32), prefect_flow_run_id: flowId,
  prefect_url: `http://localhost:14200/v2/runs/flow-run/${flowId}`,
  langfuse_url: 'http://localhost:13000/project/development/scores?filter=test',
  report_url: `/api/v1/ops/evaluations/${id}/report`,
}
const reviewDefaults = {
  quality: null, can_promote: true,
  review_version: 0, can_approve: false, approval_current: false, baseline_requires_review: false,
  rubric: { version: 'evidence-review-v1', criteria: ['조건·근거·인용을 확인합니다.'] }, case_reviews: [],
}
let authenticated = true
let fetchMock: Mock<(path: string, options?: RequestInit) => Promise<Response>>
const session = () => ({ live_enabled: true, user: authenticated ? { id: 'core:99', username: 'operator@example.com' } : null, csrf_token: authenticated ? 'rotated-token' : 'anonymous-token', datasets: authenticated ? [dataset, comparisonDataset] : [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const usageTotals = { calls: 7, inputTokens: 1200, cachedInputTokens: 200, outputTokens: 400, estimatedUsd: '0.012000', unpricedCalls: 0 }
const serviceUsage = {
  from: '2026-10-01', to: '2026-10-13', totals: usageTotals, actualUsd: null, actualConfigured: false, actualFetchedAt: null, krwPerUsd: null,
  byFeature: [{ key: 'AI_SEARCH', serviceTier: null, totals: usageTotals }],
  byModel: [{ key: 'gpt-6-luna', serviceTier: 'default', totals: usageTotals }],
  days: [{ date: '2026-10-13', calls: 7, estimatedUsd: '0.012000', actualUsd: null }],
  topAccounts: [{ accountId: 11, email: 'member@example.com', planCode: 'PLUS', totals: usageTotals }],
}

beforeEach(() => {
  authenticated = true
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.clear()
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id)
  fetchMock = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/v1/ops/session') return json(session())
    if (path.includes('/api/v1/admin/ai-costs?')) return json(serviceUsage)
    if (path.endsWith('/api/v1/admin/ai-costs/prices')) return json([])
    if (path === '/api/v1/ops/dashboard') return json({ as_of: '2026-10-07T00:00:00Z', configured_model: 'gpt-6-luna', window: { limit: 200, loaded: 0, total: 0, truncated: false }, states: { completed: 0, failed: 0, active: 0, cancelled: 0 }, excluded: { replay: 0, incomplete: 0, unverifiable: 0, duplicate: 0 }, series: [] })
    if (path.startsWith('/api/v1/ops/schedules?')) return json({ enabled: false, timezone: 'Asia/Seoul', page: 1, total: 0, results: [] })
    if (path.startsWith('/api/v1/ops/budget/reservations')) return json({
      as_of: '2026-09-29T00:00:00Z', count: 0, next: null, previous: null, results: [],
      summary: { state: 'unconfigured', limits: null, allocated: null, remaining: null, breakdown: null,
        reservation_count: 0, legacy_live_run_count: 0, change_count: 0, recent_changes: [] },
    })
    if (path.endsWith('/budget')) return json({ as_of: '2026-09-29T00:00:00Z', state: 'not_applicable', reservation: null, calls: [] })
    if (String(path).endsWith('/api/v1/auth/logout')) { authenticated = false; return new Response(null, { status: 204 }) }
    if (path.startsWith('/api/v1/ops/evaluations?page=')) return json({ count: 1, next: null, previous: null, results: [completed] })
    if (path === `/api/v1/ops/evaluations/${id}/review`) return json({ ...reviewDefaults, is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [], material: null, material_error: '' })
    if (path === `/api/v1/ops/evaluations/${id}`) return json(completed)
    if (path === '/api/v1/ops/evaluations') return json(completed, 202)
    if (/^\/api\/v1\/ops\/evaluations\/[a-f0-9-]+$/.test(path)) return json({}, 404)
    throw new Error(`예상하지 않은 호출: ${path}`)
  })
  vi.spyOn(appContainer.resolve('logInUseCase'), 'execute').mockImplementation(async () => {
    authenticated = true
    return { outcome: 'session', session: { account: { email: 'operator@example.com', role: 'ADMIN', tier: 'ADMIN', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }, expiresAt: '2026-12-01T00:00:00+09:00' } }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function open(path = '/ops/evaluations/new') {
  return render(<Provider store={createAppStore()}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Provider>)
}

describe('React LLMOps 운영 화면', () => {
  it('자료를 용도별로 묶고 선택한 자료의 설명과 기존 비교 대상을 함께 바꾼다', async () => {
    const development = { ...dataset, selection_guide: { category: 'development', title: '지원 조건 가상 사례', purpose: '가상 공고로 지원 조건 누락을 확인합니다.', material: '가상 질문 6개와 저장 응답', limitations: '실제 공고 전체의 품질을 대표하지 않습니다.' } }
    const historical = { ...comparisonDataset, selection_guide: { category: 'historical', title: '이전 프롬프트 비교', purpose: '이전 지시문의 응답 차이를 비교합니다.', material: 'E01 과거 응답 두 개', limitations: '한 질문의 과거 비교입니다.' } }
    const quality = { ...comparisonDataset, id: 'official-answer-20260907-v3', selection_guide: { category: 'quality', title: '실제 공고 답변 · 참조 보완 v3', purpose: '주어진 실제 공고 근거로 답변 품질을 평가합니다.', material: '저장 원문과 참조 조건', limitations: '검색은 평가하지 않습니다.' } }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
      ? Promise.resolve(json({ ...session(), datasets: [development, historical, quality] })) : original(path, options))
    open()
    const select = await screen.findByLabelText('평가 자료')
    expect(within(select).getAllByRole('group').map((group) => group.getAttribute('label'))).toEqual(['실제 품질 평가용', '개발 검증용', '과거 자료'])
    expect(select).toHaveProperty('value', development.id)
    expect(within(screen.getByRole('region', { name: '선택한 평가 자료 설명' })).getByText(development.selection_guide.purpose)).toBeTruthy()
    fireEvent.change(select, { target: { value: quality.id } })
    const explanation = within(screen.getByRole('region', { name: '선택한 평가 자료 설명' }))
    expect(explanation.getByRole('heading', { name: quality.selection_guide.title })).toBeTruthy()
    expect(explanation.getByText(quality.selection_guide.material)).toBeTruthy()
    expect(explanation.getByText(quality.selection_guide.limitations)).toBeTruthy()
    expect(explanation.queryByText(development.selection_guide.purpose)).toBeNull()
    expect(screen.getByLabelText('기준 실행')).toHaveProperty('value', 'reference')
    expect(screen.getByLabelText('후보 실행')).toHaveProperty('value', 'candidate')
    expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'replay')
    fireEvent.click(screen.getByRole('link', { name: '평가 이력' }))
    fireEvent.click(await screen.findByRole('link', { name: '새 평가' }))
    expect(await screen.findByLabelText('평가 자료')).toHaveProperty('value', quality.id)
    expect(screen.getByText(quality.selection_guide.limitations)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('용도 설명이 없는 이전 세션 응답은 품질 자료로 추정하지 않고 기존 선택을 유지한다', async () => {
    open()
    const select = await screen.findByLabelText('평가 자료')
    expect(within(select).getByRole('group', { name: '분류 확인 필요' })).toBeTruthy()
    expect(select).toHaveProperty('value', dataset.id)
    expect(screen.getByText('이 자료의 용도 설명이 아직 제공되지 않았습니다. 자료 이름만으로 실제 품질 평가용인지 판단하지 마세요.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '평가 실행' })).toHaveProperty('disabled', false)
  })

  it('그룹이 다른 자료를 고르면 유료 실행 동의를 해제하며 저장 전용 자료는 재평가로 전환한다', async () => {
    const quality = { ...dataset, selection_guide: { category: 'quality', title: '공식 공고 답변', purpose: '답변 확인', material: '등록된 공고 원문', limitations: '검색 미평가' } }
    const historical = { ...comparisonDataset, live_config: null, live_options: [], execution_profiles: { ...executionProfiles, live: null }, selection_guide: { category: 'historical', title: 'Core 저장 기록', purpose: '저장 기록 재평가', material: '기존 Core 응답', limitations: '저장 응답 재평가만 가능' } }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
      ? Promise.resolve(json({ ...session(), datasets: [quality, historical] })) : original(path, options))
    open()
    fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /위 자료의 OpenAI 전송/ }))
    expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: historical.id } })
    expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'replay')
    expect(screen.getByRole('option', { name: '새 응답 생성 · 유료 모델 호출' })).toHaveProperty('disabled', true)
    expect(screen.getByText('저장 응답 재평가만 가능')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: quality.id } })
    fireEvent.change(screen.getByLabelText('실행 방식'), { target: { value: 'live' } })
    expect(screen.getByRole('checkbox', { name: /위 자료의 OpenAI 전송/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('실사용 메뉴에서 Core 사용량을 읽고 기간 조회·회원 상세·Langfuse를 연결한다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
      ? Promise.resolve(json({ ...session(), search_traces_url: 'http://localhost:13000/project/development/traces' }))
      : original(path, options))
    open('/ops/dashboard')
    fireEvent.click(await screen.findByRole('link', { name: '실사용 모니터링' }))
    const stats = await screen.findByRole('region', { name: '앱 사용량 요약' })
    expect(within(stats).getByText('7회')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '기능별' })).getByText('AI 대화 검색')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '모델별' })).getByText('gpt-6-luna')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'member@example.com' }).getAttribute('href')).toBe('/app/admin/accounts/detail?accountId=11')
    expect(screen.getByRole('link', { name: '실사용 모니터링' }).getAttribute('aria-current')).toBe('page')
    expect(document.title).toBe('GovBiz · 실사용 모니터링')
    const traceLink = screen.getByRole('link', { name: 'Langfuse 실행 목록 열기 ↗' })
    expect(traceLink.getAttribute('href')).toBe('http://localhost:13000/project/development/traces')
    expect(traceLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(traceLink.getAttribute('target')).toBe('_blank')
    fireEvent.change(screen.getByLabelText('시작일', { selector: 'input[name="from"]' }), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-13' } })
    fireEvent.click(screen.getByRole('button', { name: '조회' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/admin/ai-costs?from=2026-10-01&to=2026-10-13'),
      expect.objectContaining({ credentials: 'include', cache: 'no-store' })))
    expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/v1/ops/evaluations') || path.includes('/budget/'))).toBe(false)
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })

  it('실사용 주소를 바로 열면 추적 미설정과 빈 사용량을 명시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path.includes('/api/v1/admin/ai-costs?')
      ? Promise.resolve(json({ ...serviceUsage, totals: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedUsd: '0.000000', unpricedCalls: 0 }, byFeature: [], byModel: [], days: [], topAccounts: [] }))
      : original(path, options))
    open('/ops/usage')
    expect(await screen.findByRole('heading', { level: 1, name: '실사용 모니터링' })).toBeTruthy()
    expect(await screen.findByText('회원에게 붙은 AI 호출이 없어요.')).toBeTruthy()
    expect(screen.getByText('실행 추적 연결이 설정되지 않았습니다.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Langfuse 실행 목록 열기 ↗' })).toBeNull()
    expect(screen.queryByRole('region', { name: '실측 결과 추이' })).toBeNull()
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/dashboard')).toBe(false)
  })

  it('실사용 조회 장애는 빈 결과로 숨기지 않고 다시 조회한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let failed = true
    fetchMock.mockImplementation((path, options) => failed && path.includes('/api/v1/admin/ai-costs?')
      ? Promise.resolve(json({}, 503)) : original(path, options))
    open('/ops/usage')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('AI 비용을 불러오지 못했어요.'))
    expect(screen.queryByRole('region', { name: '비용 요약' })).toBeNull()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('region', { name: '비용 요약' })).toBeTruthy()
  })

  it.each(['summary', 'sync', 'price'] as const)('실사용 %s 요청의 세션이 만료되면 비용을 지우고 로그인으로 돌아간다', async (operation) => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => {
      if ((operation === 'summary' && path.includes('/api/v1/admin/ai-costs?'))
        || (operation === 'sync' && path.endsWith('/ai-costs/sync'))
        || (operation === 'price' && path.endsWith('/ai-costs/prices') && options?.method === 'POST')) {
        authenticated = false
        return Promise.resolve(json({}, 401))
      }
      if (path.includes('/api/v1/admin/ai-costs?')) return Promise.resolve(json({ ...serviceUsage, actualConfigured: true }))
      return original(path, options)
    })
    open('/ops/usage')
    if (operation !== 'summary') {
      await screen.findByRole('region', { name: '비용 요약' })
      if (operation === 'sync') fireEvent.click(screen.getByRole('button', { name: '사용량·비용 가져오기' }))
      else {
        const form = within(screen.getByRole('form', { name: '가격 추가' }))
        fireEvent.change(form.getByLabelText('모델'), { target: { value: 'gpt-6-luna' } })
        fireEvent.change(form.getByLabelText('입력'), { target: { value: '1' } })
        fireEvent.change(form.getByLabelText('출력'), { target: { value: '2' } })
        fireEvent.click(form.getByRole('button', { name: '가격 추가' }))
      }
    }
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '비용 요약' })).toBeNull()
    expect(screen.queryByText('member@example.com')).toBeNull()
  })

  it('Core에서 실사용 조회 권한을 거절하면 회원 정보를 표시하지 않는다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path.includes('/api/v1/admin/ai-costs?')
      ? Promise.resolve(json({}, 403)) : original(path, options))
    open('/ops/usage')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('관리자 권한이 필요해요.'))
    expect(screen.queryByRole('region', { name: '비용 요약' })).toBeNull()
    expect(screen.queryByRole('region', { name: '가격표' })).toBeNull()
  })

  it('실행 상세의 Prefect 로그 버튼은 localhost 대신 관리자 API로 조회한다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === `/api/v1/ops/evaluations/${id}/logs?offset=0`
      ? Promise.resolve(json({ run_id: id, prefect_flow_run_id: flowId, offset: 0, next_offset: null, results: [] }))
      : original(path, options))
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Prefect 실행 로그' }))
    await screen.findByText('이 페이지에 저장된 실행 로그가 없습니다.')
    expect(screen.queryByRole('link', { name: 'Prefect 실행 로그' })).toBeNull()
    expect(fetchMock.mock.calls.some(([path]) => path.startsWith('http://localhost:14200'))).toBe(false)
  })

  it.each([['limits', false], ['legacy', false], ['limits', true], ['daily', false], ['daily', true]] as const)('%s 저장 후 이전 사전 점검을 지우며 늦은 조회=%s도 무시한다', async (kind, delayed) => {
    const at = '2026-10-03T01:00:00Z'
    const readiness = {
      as_of: at, dataset_id: dataset.id, execution_profile: executionProfiles.live,
      evaluation_scope: dataset.evaluation_scope, model: liveConfig.model, state: 'checked',
      required: { calls: 6, input_tokens: 196608, output_tokens: 12000 },
      remaining: { calls: 12, input_tokens: 400000, output_tokens: 24000 }, blockers: [], warnings: [],
    }
    const usage = { calls: 1, input_tokens: 100, output_tokens: 50 }
    const zero = { calls: 0, input_tokens: 0, output_tokens: 0 }
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => {
      if (path.includes('/live-readiness?')) return delayed ? pending : json(readiness)
      if (path.startsWith('/api/v1/ops/budget/reservations')) return json({
        as_of: at, count: 0, next: null, previous: null, results: [], summary: {
          state: 'consistent', limits_revision: 'a'.repeat(64), limits: readiness.remaining,
          allocated: zero, remaining: readiness.remaining, breakdown: null,
          reservation_count: 0, legacy_live_run_count: 1, change_count: 0, recent_changes: [],
          daily: { limits_revision: 'b'.repeat(64), state: 'disabled', timezone: 'Asia/Seoul', period_start: '2026-10-03T00:00:00+09:00', period_end: '2026-10-04T00:00:00+09:00', limits: null, current_day: null, carried: null, allocated: null, remaining: null, recent_changes: [] },
        },
      })
      if (path.includes('/unaccounted-runs')) return json({ as_of: at, count: 1, next: null, previous: null,
        results: [{ run_id: id, dataset_id: dataset.id, dataset_label: '과거 평가', status: 'COMPLETED', status_label: '완료', created_at: at }] })
      if (path.endsWith('/legacy-usage-preview')) return json({ as_of: at, run_id: id, applied: false, state: 'verified', can_apply: true, blockers: [],
        source: 'SAVED_CAPTURE', provider_receipt_verified: false, capture_sha256: 'b'.repeat(64), evidence_sha256: 'c'.repeat(64), usage, before: zero, after: usage })
      if (path.endsWith('/legacy-usage')) return json({ applied: true, replayed: false, record: {
        ...JSON.parse(options!.body as string), run_id: id, actor: 'core:99', actor_source: 'CORE_ADMIN', created_at: at,
        source: 'SAVED_CAPTURE', provider_receipt_verified: false, capture_sha256: 'b'.repeat(64), usage, before: zero, after: usage,
      } })
      if (path.endsWith('/budget/limits')) {
        const value = JSON.parse(options!.body as string)
        return json({ change: { request_id: value.request_id, actor: 'core:99', source: 'CORE_ADMIN', reason: value.reason,
          previous_limits: readiness.remaining, limits: { calls: value.calls, input_tokens: value.input_tokens, output_tokens: value.output_tokens }, created_at: at } })
      }
      if (path.endsWith('/budget/daily-limits')) {
        const value = JSON.parse(options!.body as string)
        return json({ change: { request_id: value.request_id, expected_revision: value.expected_revision, actor: 'core:99', source: 'CORE_ADMIN', reason: value.reason,
          previous: null, policy: { enabled: true, limits: { calls: value.calls, input_tokens: value.input_tokens, output_tokens: value.output_tokens } }, created_at: at } })
      }
      return original(path, options)
    })
    open()
    fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
    fireEvent.click(screen.getByRole('button', { name: '실행 설정·예산 점검' }))
    if (!delayed) await screen.findByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')
    fireEvent.click(screen.getByRole('link', { name: '예산 관리' }))
    if (kind === 'limits') {
      fireEvent.click(await screen.findByRole('button', { name: '누적 한도 설정' }))
      fireEvent.change(screen.getByLabelText('한도 변경 사유'), { target: { value: '실행 준비 한도 검토' } })
      fireEvent.click(screen.getByRole('button', { name: '변경 내용 확인' }))
      fireEvent.click(screen.getByRole('button', { name: '확인한 한도 저장' }))
      await screen.findByText('누적 한도 변경 이력을 저장했습니다.')
    } else if (kind === 'daily') {
      fireEvent.click(await screen.findByRole('button', { name: '일별 한도 설정' }))
      fireEvent.change(screen.getByLabelText('일별 호출 한도'), { target: { value: '12' } })
      fireEvent.change(screen.getByLabelText('일별 입력 토큰 한도'), { target: { value: '400000' } })
      fireEvent.change(screen.getByLabelText('일별 출력 토큰 한도'), { target: { value: '24000' } })
      fireEvent.change(screen.getByLabelText('일별 한도 변경 사유'), { target: { value: '일별 한도 확인' } })
      fireEvent.click(screen.getByRole('button', { name: '일별 변경 내용 확인' }))
      fireEvent.click(screen.getByRole('button', { name: '확인한 일별 정책 저장' }))
      await screen.findByText('일별 정책 변경 이력을 저장했습니다.')
    } else {
      fireEvent.click(await screen.findByRole('button', { name: '미반영 실행 목록 확인' }))
      fireEvent.click(await screen.findByRole('button', { name: `사용량 확인 ${id}` }))
      fireEvent.change(await screen.findByLabelText('사용량 검토 사유'), { target: { value: '전체 응답 검토' } })
      fireEvent.click(screen.getByRole('checkbox', { name: /위 사용량과 출처를 확인/ }))
      fireEvent.click(screen.getByRole('button', { name: '검토한 사용량 반영' }))
      await screen.findByText('검토한 과거 사용량을 장부에 반영했습니다.')
    }
    expect(screen.getByRole('region', { name: '누적 평가 예산' }).id).toBe('evaluation-budget')
    fireEvent.click(screen.getByRole('link', { name: '새 평가' }))
    if (delayed) await act(async () => { resolve(json(readiness)); await pending })
    expect(screen.queryByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')).toBeNull()
    expect(screen.getByRole('button', { name: '실행 설정·예산 점검' })).toHaveProperty('disabled', false)
    expect(fetchMock.mock.calls.filter(([path]) => path.includes('/live-readiness?'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
    expect(screen.queryByRole('region', { name: '누적 평가 예산' })).toBeNull()
  })

  it('선택한 새 모델 평가의 설정·예산만 점검하고 전송 승인을 대신하지 않는다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path.includes('/live-readiness?') ? Promise.resolve(json({
      as_of: '2026-10-03T01:00:00Z', dataset_id: dataset.id, execution_profile: executionProfiles.live,
      evaluation_scope: dataset.evaluation_scope, model: liveConfig.model, state: 'checked',
      required: { calls: 6, input_tokens: 196608, output_tokens: 12000 },
      remaining: { calls: 12, input_tokens: 400000, output_tokens: 24000 }, blockers: [], warnings: [],
    })) : original(path, options))
    open()
    const mode = await screen.findByLabelText('실행 방식')
    expect(screen.queryByRole('button', { name: '실행 설정·예산 점검' })).toBeNull()
    fireEvent.change(mode, { target: { value: 'live' } })
    expect(fetchMock.mock.calls.some(([path]) => path.includes('/live-readiness?'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '실행 설정·예산 점검' }))
    await screen.findByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')
    expect((screen.getByRole('button', { name: '새 응답 생성 및 평가' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    expect(readPendingEvaluation('core:99')).toBeNull()
    fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: comparisonDataset.id } })
    expect(screen.queryByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')).toBeNull()
    expect(fetchMock.mock.calls.filter(([path]) => path.includes('/live-readiness?'))).toHaveLength(1)
  })

  it('고정 근거 답변의 인용 지표를 검색 품질과 구분한다', async () => {
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByText('고정 근거 답변')).toBeTruthy()
    expect(screen.getByText(/검색 품질은 미측정이며 인용 재현율은 답변이 선택한 인용만 평가/)).toBeTruthy()
  })

  it('평가 범위가 없는 세션에서는 새 평가를 접수하지 않는다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
      ? Promise.resolve(json({ ...session(), datasets: [{ ...dataset, evaluation_scope: null }] }))
      : original(path, options))
    open()
    const button = await screen.findByRole('button', { name: '평가 실행' })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByText(/미확인 또는 지원하지 않는 범위/)).toBeTruthy()
    fireEvent.click(button)
    expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
  })

  it('범위가 기록되지 않은 과거 실행에 검색 평가를 추정해 표시하지 않는다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === `/api/v1/ops/evaluations/${id}`
      ? Promise.resolve(json({ ...completed, evaluation_scope: null }))
      : original(path, options))
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByText('미확인 또는 지원하지 않는 범위')).toBeTruthy()
    expect(screen.getByText(/전체 RAG 평가로 해석할 수 없습니다/)).toBeTruthy()
    expect(screen.queryByText('고정 근거 답변')).toBeNull()
  })

  it('관리자 세션의 Langfuse 추적 링크를 별도 탭으로 연다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
      ? Promise.resolve(json({ ...session(), search_traces_url: 'http://localhost:13000/project/development/traces' }))
      : original(path, options))
    open()
    const link = await screen.findByRole('link', { name: 'AI 실행 추적 ↗' })
    expect(link.getAttribute('href')).toBe('http://localhost:13000/project/development/traces')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('title')).toContain('assistant-agent')
    expect(link.getAttribute('title')).toContain('support-program-evidence')
  })

  it('평가 취소를 CSRF와 함께 접수하고 종료 확인까지 취소 요청 중으로 표시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let run = { ...completed, status: 'RUNNING', status_label: '실행 중', can_cancel: true,
      cancel_requested_at: null as string | null, cancel_requested_by: null as string | null, report_url: null }
    let finish: ((value: Response) => void) | undefined
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json(run)
      if (path.endsWith('/cancel')) return new Promise<Response>((resolve) => { finish = resolve })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    const button = await screen.findByRole('button', { name: '평가 취소 요청' })
    fireEvent.click(button)
    await waitFor(() => expect(finish).toBeTruthy())
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    const calls = fetchMock.mock.calls.filter(([path]) => path.endsWith('/cancel'))
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin',
      headers: { 'X-CSRFToken': 'rotated-token' }, body: '{}' })
    run = { ...run, status: 'CANCELLING', status_label: '취소 요청 중', can_cancel: false,
      cancel_requested_at: '2026-09-29T00:00:00Z', cancel_requested_by: 'operator@example.com' }
    await act(async () => { finish!(json(run, 202)) })
    expect(await screen.findByText('취소 요청 중')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '평가 취소 요청' })).toBeNull()
    expect(screen.getByText(/실행 종료를 확인하고 있습니다/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '같은 요청으로 접수 재확인' })).toBeNull()
  })

  it('취소 응답 유실을 완료로 표시하지 않고 같은 실행에 재요청할 수 있다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'RUNNING', status_label: '실행 중', can_cancel: true, report_url: null })
      if (path.endsWith('/cancel')) throw new Error('connection lost')
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '평가 취소 요청' }))
    expect(await screen.findByText(/취소 접수 여부는 상태를 다시 확인하세요/)).toBeTruthy()
    expect(screen.queryByText('취소')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '평가 취소 요청' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('button', { name: '평가 취소 요청' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(2))
  })

  it('실행 ID를 찾는 중인 취소 요청도 자동 갱신해 실제 취소 완료를 확인한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed,
        status: ++reads === 1 ? 'CANCELLING' : 'CANCELLED', status_label: reads === 1 ? '취소 요청 중' : '취소',
        prefect_flow_run_id: null, prefect_url: null, report_url: null,
        cancel_requested_at: '2026-09-29T00:00:00Z', cancel_requested_by: 'operator@example.com' })
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open(`/ops/evaluations/${id}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('취소 요청 중')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('취소')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(reads).toBe(2)
  })

  it('취소 버튼을 누르기 전에 계정이 바뀌면 취소를 전송하지 않는다', async () => {
    const original = fetchMock.getMockImplementation()!
    let changed = false
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/ops/session' && changed) return json({ ...session(), user: { id: 'core:100', username: 'other' } })
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'RUNNING', status_label: '실행 중', can_cancel: true, report_url: null })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    const button = await screen.findByRole('button', { name: '평가 취소 요청' })
    changed = true
    fireEvent.click(button)
    expect(await screen.findByText(/로그인 계정이 변경되었습니다/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(false)
  })

  it('상세를 열지 않아도 목록을 갱신하고 상태 확인 지연과 복구를 표시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) return json({ count: 1, next: null, previous: null, results: [++reads === 1
        ? { ...completed, status: 'RUNNING', status_label: '실행 중', status_stale: true,
            error_message: '실행 서버에 연결할 수 없습니다.', report_url: null }
        : { ...completed, synced_at: '2026-09-27T00:01:00Z', status_stale: false }] })
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = open('/ops/evaluations')
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('실행 중')).toBeTruthy()
    expect(screen.getByText(/상태 확인 지연/)).toBeTruthy()
    expect(screen.getByText(/마지막 확인: 아직 확인되지 않음/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('완료')).toBeTruthy()
    expect(screen.queryByText(/상태 확인 지연/)).toBeNull()
    expect(fetchMock.mock.calls.some(([path]) => path === `/api/v1/ops/evaluations/${id}`)).toBe(false)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(reads).toBe(2)
  })

  it('목록 자동 갱신 실패 때 기존 결과를 유지하고 다음 조회로 복구한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) {
        if (++reads === 2) return json({}, 503)
        return json({ count: 1, next: null, previous: null, results: [completed] })
      }
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open('/ops/evaluations')
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('완료')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('실패 후처리를 새 이력으로 복구하고 원본 연결과 추가 호출 0회를 표시한다', async () => {
    const original = fetchMock.getMockImplementation()!
    const child = '30000000-0000-4000-8000-000000000003'
    const recovered = { ...completed, id: child, execution_mode: 'recovery', source_run_id: id, report_url: `/api/v1/ops/evaluations/${child}/report` }
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'FAILED', report_url: null, postprocessing: {
        inputs_ready: true, stage: 'publish', can_recover: true, blocked_reason: '', attempts: [],
      } })
      if (path === `/api/v1/ops/evaluations/${id}/recover`) return json(recovered, 202)
      if (path === `/api/v1/ops/evaluations/${child}`) return json(recovered)
      if (path === `/api/v1/ops/evaluations/${child}/review`) return json({ ...reviewDefaults, is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [], material: null, material_error: '' })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '후처리 다시 실행' }))
    const link = await screen.findByRole('link', { name: '원본 실행과 실패 기록 보기' })
    expect(link.getAttribute('href')).toBe(`/ops/evaluations/${id}`)
    expect(screen.getByText(/추가 모델 호출은 0회/)).toBeTruthy()
    const options = fetchMock.mock.calls.find(([path]) => path.endsWith('/recover'))![1]!
    expect(Object.keys(JSON.parse(String(options.body)))).toEqual(['request_id'])
    expect(options.credentials).toBe('same-origin')
    expect(options.headers).toMatchObject({ 'X-CSRFToken': 'rotated-token' })
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/evaluations')).toBe(false)
  })

  it('복구 접수 응답 유실과 재확인 모두 같은 UUID와 복구 API를 사용한다', async () => {
    vi.mocked(crypto.randomUUID).mockReturnValue('30000000-0000-4000-8000-000000000003')
    const original = fetchMock.getMockImplementation()!
    const requests: string[] = []
    let child = ''
    const pending = () => ({ ...completed, id: child, execution_mode: 'recovery', source_run_id: id,
      status: 'REQUESTED', can_retry: true, prefect_flow_run_id: null, report_url: null })
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({ ...completed, status: 'FAILED', postprocessing: {
        inputs_ready: true, stage: 'report', can_recover: true, blocked_reason: '', attempts: [],
      } })
      if (path === `/api/v1/ops/evaluations/${id}/recover`) {
        child = JSON.parse(String(options?.body)).request_id
        requests.push(child)
        if (requests.length === 1) throw new TypeError('response lost')
        return json(pending(), 503)
      }
      if (child && path === `/api/v1/ops/evaluations/${child}`) return json(pending())
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '후처리 다시 실행' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('연결할 수 없습니다'))
    const recoverAgain = screen.getByRole('button', { name: '후처리 다시 실행' })
    await waitFor(() => expect(recoverAgain).toHaveProperty('disabled', false))
    fireEvent.click(recoverAgain)
    await waitFor(() => expect(requests).toHaveLength(2))
    const retry = await screen.findByRole('button', { name: '같은 요청으로 접수 재확인' })
    await waitFor(() => expect(retry).toHaveProperty('disabled', false))
    fireEvent.click(retry)
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(new Set(requests).size).toBe(1)
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/evaluations')).toBe(false)
  })

  it('불완전한 입력은 복구 버튼을 숨기고 이전 복구 이력을 보여 준다', async () => {
    const original = fetchMock.getMockImplementation()!
    const child = '30000000-0000-4000-8000-000000000003'
    fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}`
      ? json({ ...completed, status: 'FAILED', postprocessing: {
        inputs_ready: false, stage: 'unverified', can_recover: false, blocked_reason: '완료된 응답을 확인할 수 없습니다.',
        attempts: [{ id: child, status: 'CRASHED', status_label: '실행 중단' }],
      } }) : original(path, options))
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByText('완료된 응답을 확인할 수 없습니다.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '후처리 다시 실행' })).toBeNull()
    expect(screen.getByRole('link', { name: '복구 실행 30000000 · 실행 중단' }).getAttribute('href')).toBe(`/ops/evaluations/${child}`)
  })

  it('기존 로그인 화면으로 갔다가 같은 Ops 상세로 돌아오고 Core 로그아웃을 실행한다', async () => {
    authenticated = false
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'LLMOps 로그인' })).toBeNull()
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'operator@example.com' } })
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'valid-password' } })
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
    expect(await screen.findByRole('region', { name: '평가 결과' })).toBeTruthy()
    expect(appContainer.resolve('logInUseCase').execute).toHaveBeenCalledWith({ email: 'operator@example.com', password: 'valid-password', rememberMe: false })
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    const logoutOptions = fetchMock.mock.calls.find(([path]) => path.endsWith('/api/v1/auth/logout'))?.[1]
    expect(logoutOptions?.credentials).toBe('include')
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/api/v1/ops/login'))).toBe(false)
  })

  it('일반 회원은 기존 서비스 로그인 상태를 유지하면서 Ops 접근이 차단된다', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'denied' }, 403))
    const store = createAppStore()
    store.dispatch(sessionRestored({ email: 'member@example.com', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, accountType: null, onboarded: true, company: null }))
    render(<Provider store={store}><MemoryRouter initialEntries={['/ops/evaluations']}><App /></MemoryRouter></Provider>)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('관리자 계정만'))
    expect(screen.queryByRole('button', { name: '평가 실행' })).toBeNull()
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy()
  })

  it('완료 결과와 인증 보고서·외부 기록 링크를 표시한다', async () => {
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('link', { name: 'Evidently 보고서' })).toHaveProperty('pathname', `/ops/evaluations/${id}/report`)
    expect(screen.getByRole('link', { name: 'Langfuse 평가 점수' }).getAttribute('href')).toBe(completed.langfuse_url)
    expect(screen.getByText('6 / 6')).toBeTruthy()
    expect(screen.getAllByText('0회')).toHaveLength(2)
    expect(screen.getByText(/의미 충실도는 미측정/)).toBeTruthy()
  })

  it('보고서 경로는 관리자 세션으로 열고 과거 비교 기록이 없으면 원본을 안내한다', async () => {
    open(`/ops/evaluations/${id}/report`)
    expect(await screen.findByRole('heading', { name: 'Evidently 평가 보고서' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: '원본 차트 새 탭에서 보기 ↗' })).toHaveProperty('pathname', completed.report_url)
    expect(screen.getByText(/비교 기록이 없습니다/)).toBeTruthy()
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('접수 응답 유실 뒤 같은 UUID로 재시도하며 503의 저장 요청 상세를 연다', async () => {
    const original = fetchMock.getMockImplementation()!
    const requests: string[] = []
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}` && requests.length < 2) return json({}, 404)
      if (path === '/api/v1/ops/evaluations') {
        requests.push(JSON.parse(String(options?.body)).request_id)
        if (requests.length === 1) throw new TypeError('connection lost')
        return json({ ...completed, status: 'REQUESTED', status_label: '접수 중', can_retry: true, prefect_flow_run_id: null, report_url: null }, 503)
      }
      return original(path, options)
    })
    open()
    fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
    expect(await screen.findByRole('button', { name: '같은 요청으로 재시도' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
    expect(await screen.findByRole('heading', { name: '평가 실행 상세' })).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBe(requests[1])
  })

  it('실행 중 상태를 조회하다 완료되면 자동 조회를 멈춘다', async () => {
    const original = fetchMock.getMockImplementation()!
    let reads = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json(++reads === 1 ? { ...completed, status: 'RUNNING', status_label: '실행 중', report_url: null } : completed)
      return original(path, options)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open(`/ops/evaluations/${id}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('실행 중')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('완료')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(reads).toBe(2)
  })

  it('목록 실패를 빈 목록으로 숨기지 않고 재조회하며 페이지를 이동한다', async () => {
    const original = fetchMock.getMockImplementation()!
    let lists = 0
    fetchMock.mockImplementation(async (path, options) => {
      if (path.startsWith('/api/v1/ops/evaluations?page=')) {
        if (++lists === 1) return json({}, 502)
        return json({ count: 26, next: path.endsWith('page=1') ? '?page=2' : null, previous: null, results: [completed] })
      }
      return original(path, options)
    })
    open('/ops/evaluations')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('아직 실행한 평가가 없습니다.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }))
    await screen.findByRole('heading', { name: '실행 이력 · 26건' })
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/ops/evaluations?page=2', expect.anything()))
  })

  it('세션 만료 시 결과 대신 운영자 로그인을 보여 준다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => {
      if (path.includes('/evaluations')) { authenticated = false; return json({}, 401) }
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '평가 결과' })).toBeNull()
  })

  it('결과 파일 오류를 완료로 표시하지 않고 접수 재확인에도 기존 요청을 쓴다', async () => {
    const original = fetchMock.getMockImplementation()!
    let submitted = false
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/ops/evaluations') {
        expect(JSON.parse(String(options?.body))).toEqual({ request_id: id, dataset_id: dataset.id, candidate_capture_id: capture.id, reference_capture_id: capture.id, execution_mode: 'replay', live_config: {}, confirm_paid_run: false, baseline_version: null, execution_profile: null })
        submitted = true
        return json({ ...completed, status: 'QUEUED', status_label: '실행 대기', report_url: null })
      }
      if (path === `/api/v1/ops/evaluations/${id}`) return json(submitted
        ? { ...completed, status: 'RESULT_ERROR', status_label: '결과 확인 실패', report_url: null, error_code: 'RESULTS_UNAVAILABLE', error_message: '결과 파일을 확인할 수 없습니다.' }
        : { ...completed, status: 'REQUESTED', status_label: '접수 중', can_retry: true, prefect_flow_run_id: null, report_url: null })
      return original(path, options)
    })
    open(`/ops/evaluations/${id}`)
    fireEvent.click(await screen.findByRole('button', { name: '같은 요청으로 접수 재확인' }))
    expect(await screen.findByText('결과 확인 실패')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('결과 파일을 확인할 수 없습니다.')
    expect(screen.queryByRole('link', { name: 'Evidently 보고서' })).toBeNull()
    expect(screen.queryByRole('region', { name: '평가 결과' })).toBeNull()
  })

  it('잘못된 응답이나 실행 가능한 외부 링크를 렌더링하지 않는다', async () => {
    fetchMock.mockResolvedValue(json({ ...completed, langfuse_url: 'javascript:alert(1)' }))
    await expect(getEvaluation(id)).rejects.toThrow('운영 서버 응답을 확인할 수 없습니다.')
  })
  it('자료에 맞는 기준·후보를 선택하고 접수 재시도에서도 두 선택을 유지한다', async () => {
    const original = fetchMock.getMockImplementation()!
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (path, options) => {
      if (path === `/api/v1/ops/evaluations/${id}`) return json({}, 404)
      if (path === '/api/v1/ops/evaluations') {
        bodies.push(JSON.parse(String(options?.body)))
        throw new TypeError('connection lost')
      }
      return original(path, options)
    })
    open()
    const select = await screen.findByLabelText('평가 자료')
    fireEvent.change(select, { target: { value: comparisonDataset.id } })
    expect((screen.getByLabelText('기준 실행') as HTMLSelectElement).value).toBe('reference')
    expect((screen.getByLabelText('후보 실행') as HTMLSelectElement).value).toBe('candidate')
    expect(screen.getByText(/비교 범위: E01/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '평가 실행' }))
    await screen.findByRole('button', { name: '같은 요청으로 재시도' })
    expect((screen.getByLabelText('후보 실행') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({ dataset_id: comparisonDataset.id, reference_capture_id: 'reference', candidate_capture_id: 'candidate' })
  })

  it('지표 차이와 원본 범위를 표시하고 미측정을 0으로 바꾸지 않는다', async () => {
    const execution = { run_id: 'a'.repeat(32), model: 'test-model', prompt_sha256: 'p'.repeat(64), runner_sha256: 'r'.repeat(64), capture_sha256: 'c'.repeat(64), started_at: null, source_case_ids: ['E01'] }
    const comparison = { schema_version: 2, comparison: 'candidate-reference', case_ids: ['E01'],
      reference_execution: execution, candidate_execution: { ...execution, source_case_ids: ['E01', 'E07', 'E10', 'E12'] },
      metrics: [
        { key: 'meanOutputTokens', reference: 128, candidate: 91, delta: -37 },
        { key: 'statusAccuracy', reference: 0, candidate: 1, delta: 1 },
        { key: 'semanticFaithfulness', reference: null, candidate: null, delta: null },
      ], cases: [],
    }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json({ ...completed, comparison }) : original(path, options))
    open(`/ops/evaluations/${id}`)
    expect(await screen.findByRole('region', { name: '기준·후보 비교' })).toBeTruthy()
    expect(screen.getByText('-37.00')).toBeTruthy()
    expect(screen.getByText('+1.00')).toBeTruthy()
    expect(screen.getByText('비교 불가')).toBeTruthy()
    expect(screen.getAllByText('미측정')).toHaveLength(2)
    expect(screen.getByText('원본 사례: E01, E07, E10, E12')).toBeTruthy()
  })

})

it('새 모델 평가는 전송 자료와 호출 예산 확인 후 한 번만 접수한다', async () => {
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  const button = screen.getByRole('button', { name: '새 응답 생성 및 평가' })
  expect(button).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('평가 모델')).toHaveProperty('value', 'gpt-6-luna')
  expect(screen.queryByLabelText('후보 실행')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  const posts = fetchMock.mock.calls.filter(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ execution_mode: 'live', candidate_capture_id: 'new-model-response', live_config: liveConfig, confirm_paid_run: true })
})

const modelOptions = [
  { live_config: liveConfig, execution_profile: executionProfiles.live },
  { live_config: { ...liveConfig, model: 'gpt-6-sol', max_output_tokens: 4000 }, execution_profile: 'f'.repeat(64) },
  { live_config: { ...liveConfig, model: 'gpt-5.6-luna' }, execution_profile: 'a'.repeat(64) },
]

it.each([1, 2])('허용 모델 %i를 선택하면 해당 모델 설정과 실행 명세를 점검·접수한다', async (index) => {
  const original = fetchMock.getMockImplementation()!
  const option = modelOptions[index]
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/session') return json({ ...session(), datasets: [{ ...dataset, live_options: modelOptions }] })
    if (path.includes('/live-readiness?')) return json({
      as_of: '2026-10-03T01:00:00Z', dataset_id: dataset.id, execution_profile: option.execution_profile,
      evaluation_scope: dataset.evaluation_scope, model: option.live_config.model, state: 'checked',
      required: { calls: 6, input_tokens: 196608, output_tokens: 24000 },
      remaining: { calls: 12, input_tokens: 400000, output_tokens: 48000 }, blockers: [], warnings: [],
    })
    return original(path, options)
  })
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(within(screen.getByLabelText('평가 모델')).getAllByRole('option')).toHaveLength(3)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('평가 모델'), { target: { value: option.live_config.model } })
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '실행 설정·예산 점검' }))
  await screen.findByText('조회 시점의 설정·예산에서 차단 사유가 없습니다.')
  expect(fetchMock.mock.calls.find(([path]) => path.includes('/live-readiness?'))?.[0]).toBe(
    `/api/v1/ops/evaluations/live-readiness?dataset_id=${dataset.id}&execution_profile=${option.execution_profile}&model=${option.live_config.model}`,
  )
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '새 응답 생성 및 평가' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  const posts = fetchMock.mock.calls.filter(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ live_config: option.live_config, execution_profile: option.execution_profile, confirm_paid_run: true })
})

it('모델 선택은 메뉴 이동 후 유지하고 다른 자료에서 사라진 모델은 자동 대체하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
    ? Promise.resolve(json({ ...session(), datasets: [{ ...dataset, live_options: modelOptions }, comparisonDataset] })) : original(path, options))
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.change(screen.getByLabelText('평가 모델'), { target: { value: 'gpt-6-sol' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('link', { name: '예산 관리' }))
  await screen.findByRole('region', { name: '누적 평가 예산' })
  fireEvent.click(screen.getByRole('link', { name: '새 평가' }))
  expect(await screen.findByLabelText('평가 모델')).toHaveProperty('value', 'gpt-6-sol')
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: comparisonDataset.id } })
  expect(screen.getByLabelText('평가 모델')).toHaveProperty('value', 'gpt-6-sol')
  expect(screen.getByRole('alert').textContent).toContain('허용된 평가 모델을 다시 선택하세요')
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: '실행 설정·예산 점검' })).toBeNull()
  fireEvent.change(screen.getByLabelText('평가 모델'), { target: { value: 'gpt-6-luna' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('서버가 빈 허용 목록을 내려주면 이전 기본 모델로 실행하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
    ? Promise.resolve(json({ ...session(), datasets: [{ ...dataset, live_options: [] }] })) : original(path, options))
  open()
  expect(await screen.findByRole('option', { name: '새 응답 생성 · 유료 모델 호출' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('평가 자료를 바꾸면 기존 예산 확인을 해제한다', async () => {
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: comparisonDataset.id } })
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/최대 1회/)).toBeTruthy()
})

it('서버에서 비활성화한 새 모델 평가를 접수하지 않는다', async () => {
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session' ? Promise.resolve(json({ ...session(), live_enabled: false })) : fallback(path, options))
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
})

it('새 평가의 호출 수와 사례별 추적 링크를 표시하고 과거 재현 문구를 쓰지 않는다', async () => {
  fetchMock.mockResolvedValueOnce(json(session())).mockResolvedValueOnce(json({ ...completed, execution_mode: 'live', live_config: liveConfig, model_api_calls: 6, langfuse_url: null, trace_links: [{ case_id: 'TC01', url: 'http://localhost:13000/project/test/traces/abc' }] }))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByRole('link', { name: 'Langfuse TC01 추적·점수' })).toHaveProperty('href', 'http://localhost:13000/project/test/traces/abc')
  expect(screen.queryByText(/새 모델 호출은 없으며/)).toBeNull()
  expect(screen.getAllByText('6회').length).toBeGreaterThan(0)
})

const reviewMaterial = {
  capture_sha256: 'd'.repeat(64), fixture_sha256: 'c'.repeat(64),
  cases: [{ case_id: 'E01', question: '지원 대상은 누구인가요?', document_title: '가상 공고',
    evidence: [{ order: 0, text: '서울 소재 법인만 가능합니다.' }],
    answer: '<script>후보 답변은 텍스트로 표시</script>', answer_status: 'ANSWERED', cited_orders: [0],
    reference_answer: '과거 기준 답변', expected_status: 'ANSWERED', expected_citation_orders: [0],
    reference_facts: ['서울 소재 법인'], forbidden_claims: ['개인도 신청 가능'],
  }],
}

const qualityState: NonNullable<EvaluationReview['quality']> = {
  status: 'NOT_EVALUATED', is_current: false, current_id: null, input_sha256: '9'.repeat(64),
  policy: { definition: { version: 'fixed-evidence-quality-v1' }, code_sha256: '8'.repeat(64) },
  fixture_version: 0, fixture_rubric_version: 'fixture-reference-review-v1', fixture_reviews: [],
  blocked_reason: '', history: [],
}

it.each(['case', 'fixture', 'overall'] as const)('검토 새로고침은 %s 초안을 확인 없이 버리지 않고 취소 또는 명시적 재조회를 선택한다', async (kind) => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  let reads = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) { reads += 1; return json(state) }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  await screen.findByLabelText('E01 판단 사유')
  const label = { case: 'E01 판단 사유', fixture: '평가 기준 자료 검토 사유', overall: '검토 의견' }[kind]
  fireEvent.change(screen.getByLabelText(label), { target: { value: '검토 중인 근거' } })
  if (kind === 'fixture') {
    expect(screen.getByLabelText('E01 판단')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '현재 근거로 품질 판정 저장' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/저장하지 않은 기준 자료 검토가 있습니다/)).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  expect(screen.getByRole('button', { name: '입력 버리고 새로고침' })).toBeTruthy()
  expect(reads).toBe(1)
  expect(screen.getByLabelText(label)).toHaveProperty('value', '검토 중인 근거')
  fireEvent.click(screen.getByRole('button', { name: '계속 작성' }))
  expect(screen.queryByRole('button', { name: '입력 버리고 새로고침' })).toBeNull()
  expect(screen.getByLabelText(label)).toHaveProperty('value', '검토 중인 근거')
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  fireEvent.click(screen.getByRole('button', { name: '입력 버리고 새로고침' }))
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '검토 새로고침' })).toHaveProperty('disabled', false))
  expect(screen.getByLabelText(label)).toHaveProperty('value', '')
  expect(screen.getByLabelText('E01 판단')).toHaveProperty('disabled', false)
  expect(screen.getByLabelText('모든 대상 사례의 평가 기준 자료를 확인하고 위 판단을 기록합니다.')).toHaveProperty('checked', false)
  expect(screen.getByLabelText('위 모든 사례의 질문·근거·후보 답변을 검토했습니다.')).toHaveProperty('checked', false)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'DELETE')).toBe(false)
})

it('검토 재조회 중과 실패 후에는 이전 자료의 판정·기준 지정·입력을 잠그고 성공 후에만 다시 연다', async () => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, approval_current: true, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  let resolve!: (value: Response) => void
  const pending = new Promise<Response>((done) => { resolve = done })
  let reads = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return ++reads === 2 ? pending : json(state)
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  const promote = await screen.findByRole('button', { name: '비교 기준으로 지정' })
  expect(promote).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  expect(promote).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('E01 판단')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '현재 근거로 품질 판정 저장' })).toHaveProperty('disabled', true)
  await act(async () => { resolve(json({}, 503)); await pending })
  await waitFor(() => expect(screen.getByRole('button', { name: '검토 새로고침' })).toHaveProperty('disabled', false))
  expect(promote).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('평가 기준 자료 판단')).toHaveProperty('disabled', true)
  fireEvent.click(promote)
  fireEvent.click(screen.getByRole('button', { name: '현재 근거로 품질 판정 저장' }))
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  await waitFor(() => expect(promote).toHaveProperty('disabled', false))
  expect(screen.getByLabelText('E01 판단')).toHaveProperty('disabled', false)
})

it.each(['case', 'fixture', 'quality'] as const)('검토 %s 저장 충돌은 입력을 보존하고 재조회 전 재전송을 차단한다', async (kind) => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  const endpoint = { case: '/case-review', fixture: '/fixture-review', quality: '/quality' }[kind]
  const buttonName = { case: 'E01 검토 저장', fixture: '평가 기준 자료 검토 저장', quality: '현재 근거로 품질 판정 저장' }[kind]
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith(endpoint)) return json({}, 409)
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  await screen.findByLabelText('E01 판단')
  if (kind === 'case') {
    fireEvent.change(screen.getByLabelText('E01 판단'), { target: { value: 'DEFERRED' } })
    fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '원문 재확인 중' } })
  } else if (kind === 'fixture') {
    fireEvent.change(screen.getByLabelText('평가 기준 자료 판단'), { target: { value: 'DEFERRED' } })
    fireEvent.change(screen.getByLabelText('평가 기준 자료 검토 사유'), { target: { value: '원문 재확인 중' } })
    fireEvent.click(screen.getByLabelText('모든 대상 사례의 평가 기준 자료를 확인하고 위 판단을 기록합니다.'))
  }
  const save = screen.getByRole('button', { name: buttonName, hidden: true })
  fireEvent.click(save)
  await screen.findByText(/검토 기록이 변경되었습니다/)
  await waitFor(() => expect(screen.getByRole('button', { name: '검토 새로고침' })).toHaveProperty('disabled', false))
  expect(save).toHaveProperty('disabled', true)
  if (kind !== 'quality') expect(screen.getByLabelText(kind === 'case' ? 'E01 판단 사유' : '평가 기준 자료 검토 사유')).toHaveProperty('value', '원문 재확인 중')
  fireEvent.click(save)
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith(endpoint))).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  if (kind !== 'quality') fireEvent.click(screen.getByRole('button', { name: '입력 버리고 새로고침' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '현재 근거로 품질 판정 저장' })).toHaveProperty('disabled', false))
  expect(screen.getByLabelText('E01 판단 사유')).toHaveProperty('value', '')
  expect(screen.getByLabelText('평가 기준 자료 검토 사유')).toHaveProperty('value', '')
})

it.each([false, true])('전체 검토와 기준 해제(%s) 충돌은 사유를 보존하고 재저장을 막는다', async (clear) => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: clear, baseline_version: 1, baseline_history: [], reviews: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review') && options?.method !== 'POST') return json(state)
    if (path.endsWith('/review') || path.endsWith('/baseline')) return json({}, 409)
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  fireEvent.change(await screen.findByLabelText('검토 의견'), { target: { value: '수정할 조건을 재확인해야 함' } })
  if (!clear) fireEvent.click(screen.getByLabelText('위 모든 사례의 질문·근거·후보 답변을 검토했습니다.'))
  const save = screen.getByRole('button', { name: clear ? '의견을 사유로 기준 해제' : '수정 필요 저장' })
  fireEvent.click(save)
  await screen.findByText(/검토 기록이 변경되었습니다/)
  await waitFor(() => expect(screen.getByRole('button', { name: '검토 새로고침' })).toHaveProperty('disabled', false))
  expect(screen.getByLabelText('검토 의견')).toHaveProperty('value', '수정할 조건을 재확인해야 함')
  expect(save).toHaveProperty('disabled', true)
  fireEvent.click(save)
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === (clear ? 'DELETE' : 'POST'))).toHaveLength(1)
})

it('검토 진행 안내에서 닫힌 자료 검토를 열고 초점을 이동하되 승인 요청을 보내지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path.endsWith('/review')
    ? Promise.resolve(json({ ...reviewDefaults, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }))
    : original(path, options))
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  open(`/ops/evaluations/${id}`)
  fireEvent.click(await screen.findByRole('button', { name: '기준 자료 검토로 이동' }))
  const target = document.getElementById('fixture-review')
  expect(target).toHaveProperty('open', true)
  expect(document.activeElement).toBe(target)
  expect(scroll).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '평가 기준 자료 검토 저장' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

it('완료 실행도 미판정으로 표시하고 현재 근거 해시로만 품질 판정을 저장한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let state: EvaluationReview = { ...reviewDefaults, can_promote: false, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith('/quality')) {
      expect(JSON.parse(String(options?.body))).toEqual({ input_sha256: qualityState.input_sha256 })
      expect(options?.headers).toMatchObject({ 'X-CSRFToken': 'rotated-token' })
      state = { ...state, quality: { ...qualityState, status: 'NEEDS_REVIEW', is_current: true, current_id: 1,
        history: [{ id: 1, status: 'NEEDS_REVIEW', policy: qualityState.policy!, policy_sha256: '7'.repeat(64), input_sha256: qualityState.input_sha256!,
          assessed_by: 'operator@example.com', created_at: completed.created_at, reasons: [{ code: 'FIXTURE_REVIEW_REQUIRED', case_id: null, message: '평가 기준 자료의 사람 검토가 필요합니다.' }] }] } }
      return json(state)
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByRole('heading', { name: '품질 판정 · 미판정' })).toBeTruthy()
  expect(screen.getByText('완료')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '현재 근거로 품질 판정 저장' }))
  expect(await screen.findByRole('heading', { name: '품질 판정 · 검토 필요' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '비교 기준으로 지정' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
})

it('평가 기준 자료 검토는 사유와 확인 후 저장하며 후보 답변 승인을 대신하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, can_promote: false, quality: qualityState, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith('/fixture-review')) {
      expect(JSON.parse(String(options?.body))).toEqual({
        decision: 'DEFERRED', comment: '예외 조건의 근거 재검토', fixture_sha256: reviewMaterial.fixture_sha256,
        case_ids: ['E01'], rubric_version: qualityState.fixture_rubric_version, fixture_version: 0,
      })
      return json(state)
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  const button = await screen.findByRole('button', { name: '평가 기준 자료 검토 저장', hidden: true })
  expect(button).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('평가 기준 자료 판단'), { target: { value: 'DEFERRED' } })
  fireEvent.change(screen.getByLabelText('평가 기준 자료 검토 사유'), { target: { value: '예외 조건의 근거 재검토' } })
  expect(button).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByLabelText('모든 대상 사례의 평가 기준 자료를 확인하고 위 판단을 기록합니다.'))
  fireEvent.click(button)
  await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/fixture-review'))).toHaveLength(1))
  expect(fetchMock.mock.calls.some(([path, options]) => path.endsWith('/review') && options?.method === 'POST')).toBe(false)
})

it('과거 품질 합격이 있어도 근거가 바뀌면 기준 지정이 차단되고 이력이 유지된다', async () => {
  const original = fetchMock.getMockImplementation()!
  const state = { ...reviewDefaults, approval_current: true, can_promote: false, quality: { ...qualityState, status: 'NEEDS_REVIEW', history: [{
    id: 1, status: 'PASS', policy: qualityState.policy, policy_sha256: '7'.repeat(64), input_sha256: '6'.repeat(64),
    assessed_by: 'operator@example.com', created_at: completed.created_at, reasons: [],
  }] }, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  fetchMock.mockImplementation(async (path, options) => path.endsWith('/review') ? json(state) : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText(/자료·정책·검토가 변경됐습니다/)).toBeTruthy()
  expect(screen.getByText('품질 판정 이력 · 1건')).toBeTruthy()
  expect(screen.getByRole('button', { name: '비교 기준으로 지정' })).toHaveProperty('disabled', true)
})

it('근거·응답을 검토한 후 의견과 승인 기록을 저장하고 기준을 지정한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let state: EvaluationReview = { ...reviewDefaults, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}/review`) {
      if (options?.method === 'POST') {
        expect(options.headers).toMatchObject({ 'X-CSRFToken': 'rotated-token' })
        const input = JSON.parse(String(options.body))
        state = { ...state, review_version: 2, approval_current: true, reviews: [{ ...input, id: 1, version: 2, case_review_ids: [1], reviewed_by: 'operator@example.com', created_at: completed.created_at }] }
      }
      return json(state)
    }
    if (path === `/api/v1/ops/evaluations/${id}/case-review`) {
      const input = JSON.parse(String(options?.body))
      expect(input).toMatchObject({ case_id: 'E01', decision: 'SUITABLE', review_version: 0, rubric_version: reviewDefaults.rubric.version, fixture_sha256: reviewMaterial.fixture_sha256 })
      state = { ...state, review_version: 1, can_approve: true, case_reviews: [{ ...input, id: 1, version: 1, reviewed_by: 'operator@example.com', created_at: completed.created_at }] }
      return json(state)
    }
    if (path === `/api/v1/ops/evaluations/${id}/baseline`) {
      expect(JSON.parse(String(options?.body))).toEqual({ review_id: 1, baseline_version: 0 })
      state = { ...state, is_baseline: true }
      return json(state)
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText('서울 소재 법인만 가능합니다.')).toBeTruthy()
  expect(screen.getByText('<script>후보 답변은 텍스트로 표시</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
  const approve = screen.getByRole('button', { name: '검토 승인 저장' })
  const promote = screen.getByRole('button', { name: '비교 기준으로 지정' })
  expect(approve).toHaveProperty('disabled', true)
  expect(promote).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('E01 판단'), { target: { value: 'SUITABLE' } })
  fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '서울 법인 조건과 인용을 확인했습니다.' } })
  expect(approve).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'E01 검토 저장' }))
  expect(await screen.findByText('E01 사례 검토를 저장했습니다.')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('검토 의견'), { target: { value: '지역과 법인 조건을 확인했습니다.' } })
  fireEvent.click(screen.getByLabelText('위 모든 사례의 질문·근거·후보 답변을 검토했습니다.'))
  fireEvent.click(approve)
  expect(await screen.findByText('검토 기록을 저장했습니다.')).toBeTruthy()
  await waitFor(() => expect(promote).toHaveProperty('disabled', false))
  fireEvent.click(promote)
  expect(await screen.findByText('현재 데이터셋의 비교 기준')).toBeTruthy()
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
})

it('검토 기준을 다음 평가의 기준 선택에 표시하고 후보 목록과 구별한다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/session'
    ? Promise.resolve(json({ ...session(), datasets: [{ ...dataset, baseline: { version: 1, id: `run:${id}`, label: '검토 기준 · 10000000' } }] }))
    : original(path, options))
  open()
  expect(await screen.findByLabelText('기준 실행')).toHaveProperty('value', `run:${id}`)
  expect(screen.getByLabelText('후보 실행')).toHaveProperty('value', capture.id)
  fireEvent.click(screen.getByRole('button', { name: '평가 실행' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  const payload = fetchMock.mock.calls.find(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')?.[1]?.body
  expect(JSON.parse(String(payload))).toMatchObject({ reference_capture_id: `run:${id}`, execution_mode: 'replay' })
})

it('확인할 수 없는 자료를 승인하거나 기준으로 지정하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path.endsWith('/review')
    ? Promise.resolve(json({ ...reviewDefaults, material: null, material_error: '검토 자료를 확인할 수 없습니다.', reviews: [], is_baseline: false, baseline_version: 0, baseline_history: [] }))
    : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText('검토 자료를 확인할 수 없습니다.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '검토 승인 저장' })).toBeNull()
  expect(screen.queryByRole('button', { name: '비교 기준으로 지정' })).toBeNull()
})

const pendingRequest = () => ({ execution_profile: executionProfiles.live, request_id: id, dataset_id: dataset.id, candidate_capture_id: 'new-model-response', reference_capture_id: capture.id, live_config: liveConfig, baseline_version: null })

it('유료 접수 응답 유실 후 새로고침·재로그인하면 기존 요청만 조회한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let modelCalls = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/evaluations') { modelCalls++; throw new TypeError('accepted but response lost') }
    return original(path, options)
  })
  const view = open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '새 응답 생성 및 평가' }))
  await screen.findByRole('button', { name: '같은 요청으로 재시도' })
  expect(readPendingEvaluation('core:99')).toEqual(pendingRequest())
  view.unmount()
  authenticated = false
  open()
  await screen.findByRole('heading', { name: '로그인' })
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'operator@example.com' } })
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'valid-password' } })
  fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(modelCalls).toBe(1)
  expect(readPendingEvaluation('core:99')).toBeNull()
})

it('서버에 없는 보관 요청은 자동 전송하지 않고 확인 후 같은 UUID와 조건으로 접수한다', async () => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  let accepted = false
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}` && !accepted) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') {
      expect(JSON.parse(String(options?.body))).toMatchObject({ ...pendingRequest(), execution_mode: 'live', confirm_paid_run: true })
      accepted = true
    }
    return original(path, options)
  })
  open()
  await screen.findByText(/아직 접수된 요청을 찾지 못했습니다/)
  expect(accepted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(accepted).toBe(true)
  expect(readPendingEvaluation('core:99')).toBeNull()
})

it('다른 관리자의 보관 요청은 복원하거나 제거하지 않는다', async () => {
  storePendingEvaluation('core:other', pendingRequest())
  open()
  await screen.findByRole('button', { name: '평가 실행' })
  expect(screen.queryByText(/보관한 요청:/)).toBeNull()
  expect(fetchMock.mock.calls.some(([path]) => path === `/api/v1/ops/evaluations/${id}`)).toBe(false)
  expect(readPendingEvaluation('core:other')).toEqual(pendingRequest())
})

it('보관한 유료 요청은 허용 모델 목록이 바뀌어도 원래 모델·예산·명세로만 재시도한다', async () => {
  const option = modelOptions[1]
  const pending = { ...pendingRequest(), ...option }
  storePendingEvaluation('core:99', pending)
  const original = fetchMock.getMockImplementation()!
  let accepted = false
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}` && !accepted) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') {
      expect(JSON.parse(String(options?.body))).toMatchObject({ ...pending, execution_mode: 'live', confirm_paid_run: true })
      accepted = true
    }
    return original(path, options)
  })
  open()
  await screen.findByText(/아직 접수된 요청을 찾지 못했습니다/)
  expect(screen.getByLabelText('평가 모델')).toHaveProperty('value', 'gpt-6-sol')
  expect(screen.getByLabelText('평가 모델')).toHaveProperty('disabled', true)
  expect(screen.getByText(/호출당 출력 최대 4,000토큰/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '실행 설정·예산 점검' })).toBeNull()
  expect(accepted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(accepted).toBe(true)
})

it('손상된 보관 요청은 지우고 새 유료 요청을 만드는 대신 접수를 차단한다', async () => {
  sessionStorage.setItem('govbiz.ops.pending.v1.core%3A99', '{broken')
  open()
  await screen.findByText(/보관한 요청을 읽을 수 없습니다/)
  expect(screen.getByRole('button', { name: '평가 실행' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('요청 보관에 실패하면 네트워크 접수를 시작하지 않는다', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await screen.findByText(/요청을 보관할 수 없어 전송하지 않았습니다/)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('복원 조회 장애는 새 UUID 생성이나 자동 재접수로 처리하지 않는다', async () => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json({}, 503) : original(path, options))
  open()
  await screen.findByText(/관리자 인증 또는 운영 서버에 연결할 수 없습니다/)
  expect(readPendingEvaluation('core:99')).toEqual(pendingRequest())
  expect(crypto.randomUUID).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it.each(['INVALID_REFERENCE', 'LIVE_BUDGET_UNAVAILABLE'])('서버가 접수를 거절한 조건(%s)은 명시적으로 다시 선택하고 기존 유료 확인을 해제한다', async (code) => {
  storePendingEvaluation('core:99', pendingRequest())
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}`) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') return json({ code }, 400)
    return original(path, options)
  })
  open()
  await screen.findByText(/아직 접수된 요청을 찾지 못했습니다/)
  expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'live')
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  if (code === 'LIVE_BUDGET_UNAVAILABLE') await screen.findByText(/누적 평가 한도가 부족하거나 설정되지 않아 접수하지 않았습니다/)
  fireEvent.click(await screen.findByRole('button', { name: '접수되지 않은 조건 다시 선택' }))
  await screen.findByRole('button', { name: '평가 실행' })
  expect(readPendingEvaluation('core:99')).toBeNull()
  fireEvent.change(screen.getByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it.each([
  ['EVALUATION_ADMISSION_PAUSED', '점검을 위해 새 평가 접수가 중지되어 있습니다. 접수 재개 후 다시 시도해 주세요.'],
  ['EVALUATION_ADMISSION_UNAVAILABLE', '평가 접수 상태를 확인할 수 없어 접수하지 않았습니다. 운영자에게 확인해 주세요.'],
])('접수 중지 또는 확인 불가(%s)는 저장 요청의 503 응답과 구분한다', async (code, message) => {
  const original = fetchMock.getMockImplementation()!
  const requests: string[] = []
  fetchMock.mockImplementation(async (path, options) => {
    if (path === `/api/v1/ops/evaluations/${id}` && requests.length < 2) return json({}, 404)
    if (path === '/api/v1/ops/evaluations') {
      requests.push(JSON.parse(String(options?.body)).request_id)
      return requests.length === 1 ? json({ code }, 503) : json(completed, 202)
    }
    return original(path, options)
  })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await screen.findByText(message, { exact: false })
  expect(screen.queryByRole('heading', { name: '평가 실행 상세' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 재시도' }))
  expect(await screen.findByRole('heading', { name: '평가 실행 상세' })).toBeTruthy()
  expect(requests).toHaveLength(2)
  expect(requests[0]).toBe(requests[1])
})

it('접수 전 관리자 계정이 바뀌면 보관 요청을 다른 계정으로 전송하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  let sessions = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/session' && ++sessions > 1) return json({ ...session(), user: { id: 'core:other', username: 'other@example.com' } })
    return original(path, options)
  })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await screen.findByText('other@example.com')
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
  expect(readPendingEvaluation('core:99')?.request_id).toBe(id)
})

it.each([true, false])('자료 확인 가능 여부(%s)와 무관하게 기준 해제는 버전과 사유를 보내고 이력을 표시한다', async (available) => {
  const original = fetchMock.getMockImplementation()!
  const state = { ...reviewDefaults, material: available ? reviewMaterial : null, material_error: available ? '' : '저장 자료 손상', reviews: [], is_baseline: true, baseline_version: 1, baseline_history: [] }
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith('/baseline')) {
      expect(options?.method).toBe('DELETE')
      expect(JSON.parse(String(options?.body))).toEqual({ baseline_version: 1, reason: '조건 오류 재검토' })
      return json({ ...state, is_baseline: false, baseline_version: 2, baseline_history: [{ version: 2, previous_run_id: id, run_id: null, capture_sha256: null, fixture_sha256: 'c'.repeat(64), changed_by: 'operator@example.com', reason: '조건 오류 재검토', created_at: completed.created_at }] })
    }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  await screen.findByText('현재 데이터셋의 비교 기준')
  fireEvent.change(screen.getByLabelText('검토 의견'), { target: { value: '조건 오류 재검토' } })
  fireEvent.click(screen.getByRole('button', { name: '의견을 사유로 기준 해제' }))
  await screen.findByText('비교 기준을 해제했습니다.')
  expect(screen.getByText(/버전 2 · 해제/)).toBeTruthy()
})

it.each(['UNSUITABLE', 'DEFERRED'] as const)('사례 판단이 %s이면 전체 승인과 기준 지정을 차단한다', async (decision) => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [],
    review_version: 1, case_reviews: [{ id: 1, version: 1, case_id: 'E01', decision, comment: '조건을 다시 확인해야 합니다.',
      capture_sha256: reviewMaterial.capture_sha256, fixture_sha256: reviewMaterial.fixture_sha256, rubric_version: reviewDefaults.rubric.version, reviewed_by: 'reviewer@example.com', created_at: completed.created_at }] }
  fetchMock.mockImplementation((path, options) => path.endsWith('/review') ? Promise.resolve(json(state)) : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText(`저장된 판단: ${decision === 'UNSUITABLE' ? '부적합' : '판단 보류'}`)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('검토 의견'), { target: { value: '전체 의견' } })
  fireEvent.click(screen.getByLabelText('위 모든 사례의 질문·근거·후보 답변을 검토했습니다.'))
  expect(screen.getByRole('button', { name: '검토 승인 저장' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '비교 기준으로 지정' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/reviewer@example.com/)).toBeTruthy()
})

it('사례 저장 응답이 유실되면 같은 검토 버전으로 재전송하고 재진입은 조회만 한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let state: EvaluationReview = { ...reviewDefaults, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  const writes: unknown[] = []
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json(state)
    if (path.endsWith('/case-review')) {
      const input = JSON.parse(String(options?.body))
      writes.push(input)
      state = { ...state, review_version: 1, can_approve: true, case_reviews: [{ ...input, id: 1, version: 1, reviewed_by: 'operator@example.com', created_at: completed.created_at }] }
      if (writes.length === 1) throw new TypeError('response lost')
      return json(state)
    }
    return original(path, options)
  })
  const view = open(`/ops/evaluations/${id}`)
  fireEvent.change(await screen.findByLabelText('E01 판단'), { target: { value: 'SUITABLE' } })
  fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '근거와 일치' } })
  fireEvent.click(screen.getByRole('button', { name: 'E01 검토 저장' }))
  await screen.findByText(/운영 서버에 연결할 수 없습니다/)
  const retry = screen.getByRole('button', { name: 'E01 검토 저장' })
  await waitFor(() => expect(retry).toHaveProperty('disabled', false))
  fireEvent.click(retry)
  await screen.findByText('E01 사례 검토를 저장했습니다.')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  view.unmount()
  open(`/ops/evaluations/${id}`)
  await screen.findByText('저장된 판단: 적합')
  expect(writes).toHaveLength(2)
})

it('다른 관리자 검토 충돌 후 최신 버전은 새로 조회하고 다시 입력한 판단에만 사용한다', async () => {
  const original = fetchMock.getMockImplementation()!
  let version = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) return json({ ...reviewDefaults, review_version: version, material: reviewMaterial, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] })
    if (path.endsWith('/case-review')) { version = 1; return json({}, 409) }
    return original(path, options)
  })
  open(`/ops/evaluations/${id}`)
  fireEvent.change(await screen.findByLabelText('E01 판단'), { target: { value: 'DEFERRED' } })
  fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '조건 확인 대기' } })
  fireEvent.click(screen.getByRole('button', { name: 'E01 검토 저장' }))
  await screen.findByText(/검토 기록이 변경되었습니다/)
  expect(screen.getByLabelText('E01 판단 사유')).toHaveProperty('value', '조건 확인 대기')
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/case-review'))).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '검토 새로고침' }))
  fireEvent.click(screen.getByRole('button', { name: '입력 버리고 새로고침' }))
  await waitFor(() => expect(screen.getByLabelText('E01 판단')).toHaveProperty('disabled', false))
  expect(screen.getByRole('button', { name: 'E01 검토 저장' })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('E01 판단 사유')).toHaveProperty('value', '')
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/case-review'))).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('E01 판단'), { target: { value: 'UNSUITABLE' } })
  fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '최신 자료와 답변을 다시 대조함' } })
  fireEvent.click(screen.getByRole('button', { name: 'E01 검토 저장' }))
  await screen.findByText(/검토 기록이 변경되었습니다/)
  const writes = fetchMock.mock.calls.filter(([path]) => path.endsWith('/case-review'))
  expect(writes).toHaveLength(2)
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ review_version: 0, comment: '조건 확인 대기' })
  expect(JSON.parse(String(writes[1][1]?.body))).toMatchObject({ review_version: 1, decision: 'UNSUITABLE', comment: '최신 자료와 답변을 다시 대조함' })
})

it('과거 전체 승인을 사례별 승인으로 표시하지 않고 기존 기준의 재검토 필요를 알린다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path.endsWith('/review') ? Promise.resolve(json({ ...reviewDefaults,
    material: reviewMaterial, material_error: '', is_baseline: true, baseline_requires_review: true, baseline_version: 1, baseline_history: [],
    reviews: [{ id: 1, decision: 'APPROVED', comment: '이전 전체 승인', capture_sha256: reviewMaterial.capture_sha256,
      fixture_sha256: '', rubric_version: '', version: null, case_review_ids: [], reviewed_by: 'old-reviewer@example.com', created_at: completed.created_at }],
  })) : original(path, options))
  open(`/ops/evaluations/${id}`)
  await screen.findByText('이전 승인 · 사례별 재검토 필요')
  expect(screen.getByText(/유효한 품질 합격과 전체 승인을 완료하기 전에는/)).toBeTruthy()
  expect(screen.getByText('저장된 판단: 미검토')).toBeTruthy()
  expect(screen.getByRole('button', { name: '검토 승인 저장' })).toHaveProperty('disabled', true)
})

it('접수 직전 서버 버전이 바뀌어도 사용자가 확인한 명세를 자동 교체하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  let sessions = 0
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/session') {
      sessions += 1
      const value = session()
      if (sessions > 1) value.datasets = value.datasets.map((item) => ({ ...item, execution_profiles: { replay: 'f'.repeat(64), live: 'f'.repeat(64) } }))
      return json(value)
    }
    return original(path, options)
  })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/ops/evaluations')).toBe(true))
  const request = fetchMock.mock.calls.find(([path]) => path === '/api/v1/ops/evaluations')!
  expect(JSON.parse(request[1]!.body as string).execution_profile).toBe(executionProfiles.replay)
})

it('명세 불일치와 접수 명세 ID를 표시하고 확인되지 않은 호출 수를 0회로 바꾸지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}`
    ? json({ ...completed, status: 'FAILED', status_label: '실패', model_api_calls: null, report_url: null,
      execution_spec_sha256: 'f'.repeat(64), error_code: 'EXECUTION_SPEC_MISMATCH',
      error_message: '접수 당시 명세와 실행 환경이 달라 모델 호출 전에 차단했습니다.' })
    : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText('접수 당시 명세와 실행 환경이 달라 모델 호출 전에 차단했습니다.')).toBeTruthy()
  expect(screen.getByText('f'.repeat(64))).toBeTruthy()
  expect(screen.getByText('아직 확인되지 않음')).toBeTruthy()
})

it('명세가 없던 탭 보관 기록을 현재 명세로 소급 채우지 않는다', () => {
  const { execution_profile: _profile, ...legacy } = pendingRequest()
  sessionStorage.setItem('govbiz.ops.pending.v1.core%3A99', JSON.stringify(legacy))
  expect(readPendingEvaluation('core:99')?.execution_profile).toBeNull()
})

const ragDataset = {
  id: 'rag-synthetic-multichunk-v1', label: '전체 RAG · 합성 다중 청크 캡처 재계산',
  evaluation_scope: 'source-chunks-retrieval-answer', fixture: 'rag-fixture.json',
  live_config: null, execution_profiles: { replay: 'f'.repeat(64), live: null }, baseline: null,
  case_ids: ['R01', 'R02', 'R03'], captures: [{ id: 'rag-synthetic-capture-v1', label: '합성 RAG 캡처' }],
}
const ragReport = {
  scope: 'source-chunks-retrieval-answer', measurementKind: 'synthetic-contract-check',
  baselineEligible: false, liveExecutionPerformed: false, completed: false, caseCount: 3,
  fixtureSha256: 'a'.repeat(64), captureSha256: 'b'.repeat(64),
  execution: { model: null, embeddingModel: null, promptSha256: null },
  coverage: { retrievalCaseCount: 2, answerCaseCount: 2, failedCaseCount: 1, traceCaseCount: 0 },
  metrics: {
    retrievalRecallAtK: { value: 0, measuredCaseCount: 1, eligibleCaseCount: 2 },
    answerCitationRecall: { value: 0, measuredCaseCount: 1, eligibleCaseCount: 2 },
    answerStatusAccuracy: { value: 1, measuredCaseCount: 2, eligibleCaseCount: 3 },
  },
  cases: [
    { caseId: 'R01', traceId: null, retrievalRecallAtK: null, answerCitationRecall: null, answerStatusMatches: null, failure: { stage: 'search', code: 'timeout' }, retrievedChunkIds: null, citedChunkIds: null },
    { caseId: 'R02', traceId: null, retrievalRecallAtK: 0, answerCitationRecall: 0, answerStatusMatches: true, failure: null, retrievedChunkIds: ['chunk-2'], citedChunkIds: [] },
    { caseId: 'R03', traceId: null, retrievalRecallAtK: null, answerCitationRecall: null, answerStatusMatches: true, failure: null, retrievedChunkIds: ['chunk-3'], citedChunkIds: [] },
  ],
}
const ragRun = {
  ...completed, dataset_id: ragDataset.id, dataset_label: ragDataset.label,
  evaluation_scope: ragDataset.evaluation_scope,
  candidate_capture_id: ragDataset.captures[0].id, reference_capture_id: ragDataset.captures[0].id,
  comparison: { schema_version: 3, scope: ragDataset.evaluation_scope, retrieval_evaluated: true,
    baseline_eligible: false, comparison: 'self-replay', case_ids: ragDataset.case_ids,
    current: ragReport, reference: ragReport },
  summary: { caseCount: 3, semanticFaithfulness: null },
}

describe('전체 RAG 저장 캡처 재평가', () => {
  it('자료 변경 시 무료 재평가로 전환하고 live 명세 없이 접수한다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => {
      if (path === '/api/v1/ops/session') return json({ ...session(), datasets: [dataset, ragDataset] })
      if (path === '/api/v1/ops/evaluations' && options?.method === 'POST') return json(ragRun, 202)
      if (path === `/api/v1/ops/evaluations/${id}`) return json(ragRun)
      return original(path, options)
    })
    open('/ops/evaluations/new')
    fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
    fireEvent.change(screen.getByLabelText('평가 자료'), { target: { value: ragDataset.id } })
    expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'replay')
    expect(screen.getByRole('option', { name: '새 응답 생성 · 유료 모델 호출' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '평가 실행' }))
    await screen.findByRole('heading', { name: 'RAG 검색·답변 결과 비교' })
    const post = fetchMock.mock.calls.find(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')!
    const body = JSON.parse(post[1]!.body as string)
    expect(body).toMatchObject({ dataset_id: ragDataset.id, execution_mode: 'replay', live_config: {}, confirm_paid_run: false, execution_profile: ragDataset.execution_profiles.replay })
  })

  it('원본 실패·분모·합성 출처와 기준 지정 조건을 표시하고 검토는 명시적으로 연다', async () => {
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json(ragRun) : original(path, options))
    open(`/ops/evaluations/${id}`)
    await screen.findByRole('heading', { name: 'RAG 검색·답변 결과 비교' })
    expect(screen.getAllByText('합성 결과 재계산 · 실제 모델 품질 측정 아님').length).toBeGreaterThan(0)
    expect(screen.getByText(/원본 실패 1건/)).toBeTruthy()
    expect(screen.getByText('검색 실패 · timeout')).toBeTruthy()
    expect(screen.getAllByText('0.00 (1 / 2)').length).toBeGreaterThan(0)
    expect(screen.getByText(/비교 기준 지정에는 실제 모델 기록과 별도의 사람 검토·품질 합격이 필요합니다/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '검토 자료 보기' })).toBeTruthy()
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/rag-material') || path.endsWith('/rag-reviews'))).toBe(false)
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/review'))).toBe(false)
    expect(screen.queryByRole('button', { name: /기준으로 지정/ })).toBeNull()
  })
})

const ragLiveConfig = { ...liveConfig, max_model_calls: 9, max_input_tokens: 32768,
  embedding_model: 'text-embedding-3-small', embedding_dimensions: 1536, source_mode: 'fixed-source-and-chunks',
  max_total_input_tokens: 98999, max_total_output_tokens: 6000 }
const ragLiveDataset = { ...ragDataset, live_config: ragLiveConfig, execution_profiles: executionProfiles }

it('벡터 재사용·생성·공유 계획을 표시하고 승인한 해시를 그대로 접수한다', async () => {
  const config = { ...ragLiveConfig, document_vectors: {
    R01: { key: 'a'.repeat(64), sha256: 'b'.repeat(64), source_case_id: 'R01' },
    R02: { key: 'c'.repeat(64), sha256: null, source_case_id: 'R02' },
    R03: { key: 'c'.repeat(64), sha256: null, source_case_id: 'R02' },
  } }
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => path === '/api/v1/ops/session'
    ? json({ ...session(), rag_live_enabled: true, datasets: [{ ...ragLiveDataset, live_config: config }] })
    : original(path, options))
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getByText('저장 벡터 재사용 1사례 · 새 임베딩 1묶음 · 실행 내 공유 1사례')).toBeTruthy()
  expect(screen.getByText('R01: 저장 벡터 재사용')).toBeTruthy()
  expect(screen.getByText('R02: 새 임베딩')).toBeTruthy()
  expect(screen.getByText('R03: 이번 실행의 R02 벡터 재사용')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('위 자료의 OpenAI 전송과 최대 호출 예산을 확인했습니다.'))
  fireEvent.click(screen.getByRole('button', { name: '새 응답 생성 및 평가' }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(true))
  const post = fetchMock.mock.calls.find(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')!
  expect(JSON.parse(String(post[1]?.body)).live_config.document_vectors).toEqual(config.document_vectors)
})

it.each([false, true])('RAG 별도 활성화(%s)와 전송·예산 확인이 있어야 새 실행을 접수한다', async (enabled) => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (path, options) => {
    if (path === '/api/v1/ops/session') return json({ ...session(), rag_live_enabled: enabled, datasets: [ragLiveDataset] })
    return original(path, options)
  })
  open()
  fireEvent.change(await screen.findByLabelText('실행 방식'), { target: { value: 'live' } })
  expect(screen.getAllByText(/Core 원문 재수집·재청킹 및 운영 색인 성능은 측정하지 않습니다/).length).toBeGreaterThan(0)
  expect(screen.getByText(/전체 입력 예약 98,999토큰 · 전체 출력 예약 6,000토큰/)).toBeTruthy()
  const button = screen.getByRole('button', { name: '새 응답 생성 및 평가' })
  const confirmation = screen.getByLabelText('위 자료의 OpenAI 전송과 최대 호출 예산을 확인했습니다.')
  expect(button).toHaveProperty('disabled', true)
  expect(confirmation).toHaveProperty('disabled', !enabled)
  if (enabled) {
    fireEvent.click(confirmation)
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toHaveLength(1))
    const body = JSON.parse(String(fetchMock.mock.calls.find(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')![1]?.body))
    expect(body).toMatchObject({ execution_mode: 'live', candidate_capture_id: 'new-model-response',
      dataset_id: ragDataset.id, live_config: ragLiveConfig, confirm_paid_run: true, execution_profile: executionProfiles.live })
  } else {
    expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/v1/ops/evaluations' && options?.method === 'POST')).toBe(false)
  }
})

it('RAG 새 실행을 무료 재계산으로 표시하지 않는다', async () => {
  const original = fetchMock.getMockImplementation()!
  const run = { ...ragRun, execution_mode: 'live', live_config: ragLiveConfig, model_api_calls: 9,
    comparison: { ...ragRun.comparison, current: { ...ragReport, measurementKind: 'recorded-live-evaluation', liveExecutionPerformed: true } } }
  fetchMock.mockImplementation(async (path, options) => path === `/api/v1/ops/evaluations/${id}` ? json(run) : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText(/새 모델 실행 결과입니다/)).toBeTruthy()
  expect(screen.queryByText(/이번 재계산의 모델 API 호출은 0회/)).toBeNull()
})


it.each([false, true])('실제 공고는 출처와 과거 모델·참조 보완(%s)을 표시하고 미검토 승격을 막는다', async (revised) => {
  const original = fetchMock.getMockImplementation()!
  const state: EvaluationReview = { ...reviewDefaults, can_promote: false, quality: qualityState,
    material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [],
    material: { ...reviewMaterial, data_type: 'official-html-snapshot', candidate_origin: 'historical-answer-projection',
      recorded_model: 'gpt-5.6-luna', recorded_at: '2026-09-06T16:10:50Z',
      reference_revision: revised ? {
        previous_dataset_id: 'official-answer-20260907-v2', previous_fixture_sha256: 'c'.repeat(64),
        changed_case_ids: ['H01'], reason: '중소·중견 제조기업 범위 보완 · 사람 검토 필요',
        source_quote: '☞ 중소ㆍ중견 제조기업의 자발적인 스마트공장 구축 및 고도화',
      } : null,
      cases: [{ ...reviewMaterial.cases[0], source: {
        url: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000116004',
        collected_at: '2026-09-06T15:13:00Z', html_sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64),
        scope: 'frozen-title-and-body-html-no-attachments',
      } }],
    },
  }
  fetchMock.mockImplementation(async (path, options) => path.endsWith('/review') ? json(state) : original(path, options))
  open(`/ops/evaluations/${id}`)
  expect(await screen.findByText(/과거 저장 응답 · gpt-5.6-luna/)).toBeTruthy()
  expect(screen.getByText(/첨부파일과 현재 공고의 변경 내용은 포함하지 않습니다/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '공고 출처 보기' }).getAttribute('href')).toBe(state.material!.cases[0].source!.url)
  if (revised) {
    const revision = screen.getByRole('region', { name: '참조 조건 변경 내용' })
    expect(revision.textContent).toContain('H01')
    expect(revision.textContent).toContain('중소·중견 제조기업 범위 보완')
    expect(revision.textContent).toContain('이전 자료의 승인·비교 기준은 이 버전에 승계되지 않으므로')
  } else expect(screen.queryByRole('region', { name: '참조 조건 변경 내용' })).toBeNull()
  expect(screen.getByRole('button', { name: '검토 승인 저장' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '비교 기준으로 지정' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('작업 메뉴마다 해당 기능만 표시하고 다른 기능의 조회를 시작하지 않는다', async () => {
  open('/ops/evaluations')
  await screen.findByRole('region', { name: '평가 실행 이력' })
  const menu = within(screen.getByRole('navigation', { name: 'LLMOps 작업 메뉴' }))
  expect(menu.getByRole('link', { name: '평가 이력' }).getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('region', { name: '평가 실행' })).toBeNull()
  expect(screen.queryByRole('region', { name: '누적 평가 예산' })).toBeNull()
  expect(screen.queryByRole('region', { name: '정기 평가 계획' })).toBeNull()
  expect(fetchMock.mock.calls.some(([path]) => path.includes('/budget/') || path.includes('/schedules?'))).toBe(false)
  fireEvent.click(menu.getByRole('link', { name: '새 평가' }))
  await screen.findByRole('region', { name: '평가 실행' })
  expect(screen.queryByRole('region', { name: '평가 실행 이력' })).toBeNull()
  expect(document.activeElement?.id).toBe('ops-main')
  fireEvent.click(menu.getByRole('link', { name: '예산 관리' }))
  await screen.findByRole('region', { name: '누적 평가 예산' })
  expect(screen.queryByRole('region', { name: '평가 실행' })).toBeNull()
  fireEvent.click(menu.getByRole('link', { name: '정기 실행' }))
  await screen.findByText('등록된 정기 계획이 없습니다.')
  expect(screen.queryByRole('region', { name: '누적 평가 예산' })).toBeNull()
  expect(menu.getByRole('link', { name: '정기 실행' }).getAttribute('aria-current')).toBe('page')
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it.each([
  ['/ops/dashboard', '성능 대시보드'], ['/ops', '성능 대시보드'],
  ['/ops/login', '성능 대시보드'], ['/ops/unknown', '성능 대시보드'],
  ['/ops/evaluations#evaluation-budget', '예산 관리'],
  ['/ops/evaluations#evaluation-schedules', '정기 실행'],
  ['/ops/evaluations#new-evaluation', '새 평가'],
  ['/ops/budget', '예산 관리'], ['/ops/schedules', '정기 실행'],
])('기존 바로가기와 직접 주소 %s는 %s 화면을 연다', async (path, heading) => {
  open(path)
  expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy()
  expect(screen.queryByRole('region', { name: '평가 실행 이력' })).toBeNull()
  if (heading === '성능 대시보드') {
    expect(screen.getByRole('link', { name: '성능 대시보드' }).getAttribute('aria-current')).toBe('page')
    expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/v1/ops/evaluations'))).toBe(false)
  }
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('운영 로고는 평가 이력에서 성능 대시보드로 돌아간다', async () => {
  open('/ops/evaluations')
  await screen.findByRole('heading', { level: 1, name: '평가 이력' })
  fireEvent.click(screen.getByRole('link', { name: 'GovBiz LLMOps' }))
  expect(await screen.findByRole('heading', { level: 1, name: '성능 대시보드' })).toBeTruthy()
  expect(screen.queryByRole('region', { name: '평가 실행 이력' })).toBeNull()
})

it('예산 화면을 다녀와도 평가 선택은 유지하고 유료 전송 확인은 해제한다', async () => {
  open()
  fireEvent.change(await screen.findByLabelText('평가 자료'), { target: { value: comparisonDataset.id } })
  fireEvent.change(screen.getByLabelText('실행 방식'), { target: { value: 'live' } })
  fireEvent.click(screen.getByLabelText('위 자료의 OpenAI 전송과 최대 호출 예산을 확인했습니다.'))
  fireEvent.click(screen.getByRole('link', { name: '예산 관리' }))
  await screen.findByRole('region', { name: '누적 평가 예산' })
  fireEvent.click(screen.getByRole('link', { name: '새 평가' }))
  expect(await screen.findByLabelText('평가 자료')).toHaveProperty('value', comparisonDataset.id)
  expect(screen.getByLabelText('실행 방식')).toHaveProperty('value', 'live')
  expect(screen.getByLabelText('위 자료의 OpenAI 전송과 최대 호출 예산을 확인했습니다.')).toHaveProperty('checked', false)
  expect(screen.getByRole('button', { name: '새 응답 생성 및 평가' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it.each(['/ops/dashboard', '/ops', '/ops/login', '/ops/budget', '/ops/schedules', '/ops/evaluations/new'])('로그인 후 요청한 작업 화면 %s로 복귀한다', async (path) => {
  authenticated = false
  open(path)
  fireEvent.change(await screen.findByLabelText('이메일'), { target: { value: 'operator@example.com' } })
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'example-password' } })
  fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
  const name = ['/ops/dashboard', '/ops', '/ops/login'].includes(path) ? '성능 대시보드' : path.endsWith('budget') ? '예산 관리' : path.endsWith('schedules') ? '정기 실행' : '새 평가'
  expect(await screen.findByRole('heading', { level: 1, name })).toBeTruthy()
})

it('사례를 한 건씩 보여주며 사례 전환 후에도 저장 전 판단과 사유를 보존한다', async () => {
  const original = fetchMock.getMockImplementation()!
  const material = { ...reviewMaterial, cases: [reviewMaterial.cases[0], { ...reviewMaterial.cases[0], case_id: 'E02', question: '두 번째 질문' }] }
  fetchMock.mockImplementation((path, options) => path.endsWith('/review')
    ? Promise.resolve(json({ ...reviewDefaults, quality: qualityState, material, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }))
    : original(path, options))
  open(`/ops/evaluations/${id}`)
  fireEvent.change(await screen.findByLabelText('E01 판단'), { target: { value: 'DEFERRED' } })
  fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '첨부 원문 확인 중' } })
  fireEvent.click(screen.getByRole('button', { name: '다음 사례' }))
  expect(screen.queryByLabelText('E01 판단')).toBeNull()
  expect(screen.getByLabelText('E02 판단')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('button', { name: '이전 사례' }))
  expect(screen.getByLabelText('E01 판단')).toHaveProperty('value', 'DEFERRED')
  expect(screen.getByLabelText('E01 판단 사유')).toHaveProperty('value', '첨부 원문 확인 중')
  expect(screen.getByRole('button', { name: '검토 승인 저장' })).toHaveProperty('disabled', true)
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it.each([true, false])('저장 후 다음 사례는 저장 성공(%s)일 때만 이동하고 실패 시 초안을 보존한다', async (success) => {
  const original = fetchMock.getMockImplementation()!
  const material = { ...reviewMaterial, cases: [reviewMaterial.cases[0], { ...reviewMaterial.cases[0], case_id: 'E02', question: '두 번째 질문' }] }
  const state = { ...reviewDefaults, quality: qualityState, material, material_error: '', is_baseline: false, baseline_version: 0, baseline_history: [], reviews: [] }
  let resolveSave!: (response: Response) => void
  const response = new Promise<Response>((resolve) => { resolveSave = resolve })
  fetchMock.mockImplementation((path, options) => {
    if (path.endsWith('/case-review') && options?.method === 'POST') return response
    if (path.endsWith('/review')) return Promise.resolve(json(state))
    return original(path, options)
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  try {
    open(`/ops/evaluations/${id}`)
    fireEvent.change(await screen.findByLabelText('E01 판단'), { target: { value: 'UNSUITABLE' } })
    fireEvent.change(screen.getByLabelText('E01 판단 사유'), { target: { value: '지원 대상 누락' } })
    fireEvent.click(screen.getByRole('button', { name: '저장 후 다음 사례' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true))
    expect(screen.getByLabelText('E01 판단')).toBeTruthy()
    await act(async () => {
      resolveSave(success ? json({ ...state, review_version: 1, case_reviews: [{ id: 1, version: 1, case_id: 'E01', decision: 'UNSUITABLE', comment: '지원 대상 누락', capture_sha256: material.capture_sha256, fixture_sha256: material.fixture_sha256, rubric_version: state.rubric.version, reviewed_by: 'operator@example.com', created_at: completed.created_at }] }) : json({ detail: '저장 실패' }, 503))
      await response
    })
    if (success) {
      await screen.findByLabelText('E02 판단')
      expect(document.activeElement?.id).toBe('case-review-E02')
      expect(screen.getByRole('button', { name: '검토 승인 저장' })).toHaveProperty('disabled', true)
    } else {
      expect(screen.getByLabelText('E01 판단 사유')).toHaveProperty('value', '지원 대상 누락')
      expect(screen.queryByLabelText('E02 판단')).toBeNull()
    }
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  } finally { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView }
})

it('접수 중 메뉴를 옮겨도 늦은 응답이 현재 화면을 바꾸지 않고 재진입 시 같은 요청만 조회한다', async () => {
  let resolve!: (response: Response) => void
  const response = new Promise<Response>((done) => { resolve = done })
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((path, options) => path === '/api/v1/ops/evaluations' && options?.method === 'POST' ? response : original(path, options))
  open()
  fireEvent.click(await screen.findByRole('button', { name: '평가 실행' }))
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1))
  fireEvent.click(screen.getByRole('link', { name: '예산 관리' }))
  await screen.findByRole('region', { name: '누적 평가 예산' })
  await act(async () => { resolve(json(completed, 202)); await response })
  expect(screen.getByRole('heading', { level: 1, name: '예산 관리' })).toBeTruthy()
  expect(readPendingEvaluation('core:99')?.request_id).toBe(id)
  fireEvent.click(screen.getByRole('link', { name: '새 평가' }))
  await screen.findByRole('heading', { name: '평가 실행 상세' })
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  expect(readPendingEvaluation('core:99')).toBeNull()
})

it('이력 화면을 떠나면 목록 자동 조회를 중단한다', async () => {
  open('/ops/evaluations')
  await screen.findByText(completed.dataset_label)
  fireEvent.click(screen.getByRole('link', { name: '새 평가' }))
  await screen.findByLabelText('평가 자료')
  const reads = () => fetchMock.mock.calls.filter(([path]) => path.includes('/evaluations?page='))
  const count = reads().length
  expect(reads()[0][1]?.signal?.aborted).toBe(true)
  vi.useFakeTimers()
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(reads()).toHaveLength(count)
})
