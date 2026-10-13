// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraceDetailPage, TraceListPage } from './TracePages'

const from = '2026-10-07T00:00:00Z'
const to = '2026-10-14T00:00:00Z'
const traceId = 'abcdef1234567890abcdef1234567890'
const root = {
  id: 'root-001', trace_id: traceId, name: 'support-program-search', type: 'SPAN',
  started_at: '2026-10-13T09:00:00Z', ended_at: null, level: 'DEFAULT', status_message: null, model: null,
  latency_seconds: null, total_cost: null, environment: 'production',
}
const child = {
  ...root, id: 'child-02', name: 'OpenAI generation', type: 'GENERATION', parent_observation_id: root.id,
  input: '<img src=x onerror=alert(1)>', output: '<script>alert(2)</script>',
  metadata: { source: '정부지원사업' }, usage_details: { input: 123, output: 42 }, model: 'gpt-6-luna',
}
const page = { results: [root], from_time: from, to_time: to, next_cursor: 'page-2' }
const detail = {
  trace_id: traceId, next_cursor: null,
  observations: [{ ...root, parent_observation_id: null, input: null, output: null, metadata: null, usage_details: null }, child],
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function mount(url = '/ops/traces', onExpired = vi.fn()) {
  return render(<MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/ops/traces" element={<TraceListPage onExpired={onExpired} />} />
    <Route path="/ops/traces/:traceId" element={<TraceDetailPage onExpired={onExpired} />} />
  </Routes></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('관리자 AI 실행 추적', () => {
  it('동일 trace의 루트 단계를 각각 표시하고 다음 페이지에 고정 기간과 필터를 유지한다', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...page, results: [root, { ...root, id: 'root-002' }] })).mockResolvedValue(json({ ...page, results: [], next_cursor: null }))
    vi.stubGlobal('fetch', fetch)
    mount('/ops/traces?name=support-program-search')
    expect(await screen.findByRole('link', { name: '공고 검색 · root-001' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '공고 검색 · root-002' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다음 페이지' }))
    await screen.findByRole('heading', { name: '이 기간에 기록된 실행이 없습니다.' })
    const query = new URL(fetch.mock.calls[1][0], 'https://govbiz.test').searchParams
    expect(Object.fromEntries(query)).toEqual({ name: 'support-program-search', from_time: from, to_time: to, cursor: 'page-2' })
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(screen.getByRole('button', { name: '다음 페이지' })).toHaveProperty('disabled', true)
  })

  it('이름·기간을 조회하면 페이지를 초기화하고 입력 조건으로 요청한다', async () => {
    const fetch = vi.fn().mockResolvedValue(json(page))
    vi.stubGlobal('fetch', fetch)
    mount(`/ops/traces?${new URLSearchParams({ from_time: from, to_time: to, cursor: 'old-cursor' })}`)
    await screen.findByRole('link', { name: '공고 검색 · root-001' })
    fireEvent.change(screen.getByLabelText('실행 이름'), { target: { value: 'assistant-agent' } })
    fireEvent.change(screen.getByLabelText('조회 기간'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '조회', exact: true }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const query = new URL(fetch.mock.calls[1][0], 'https://govbiz.test').searchParams
    expect(query.get('name')).toBe('assistant-agent')
    expect(query.has('cursor')).toBe(false)
    expect(Date.parse(query.get('to_time')!) - Date.parse(query.get('from_time')!)).toBe(30 * 86_400_000)
  })

  it('상세에서 부모 단계와 입력·출력을 안전한 텍스트로 읽고 같은 목록으로 복귀한다', async () => {
    const fetch = vi.fn(async (url: string) => json(url.startsWith(`/api/v1/ops/traces/${traceId}`) ? detail : page))
    vi.stubGlobal('fetch', fetch)
    mount('/ops/traces?name=support-program-search')
    fireEvent.click(await screen.findByRole('link', { name: '공고 검색 · root-001' }))
    const stages = await screen.findByRole('region', { name: '실행 단계' })
    expect(within(stages).getByText(/상위 단계: 공고 검색 \(root-001\)/)).toBeTruthy()
    expect(within(stages).getByText(child.input)).toBeTruthy()
    expect(within(stages).getByText(child.output)).toBeTruthy()
    expect(stages.querySelectorAll('img,script,iframe').length).toBe(0)
    const back = screen.getByRole('link', { name: '← 조회하던 실행 목록으로' })
    expect(new URL(back.getAttribute('href')!, 'https://govbiz.test').searchParams.get('from_time')).toBe(from)
    fireEvent.click(back)
    await screen.findByRole('link', { name: '공고 검색 · root-001' })
    const query = new URL(fetch.mock.calls.at(-1)![0], 'https://govbiz.test').searchParams
    expect(Object.fromEntries(query)).toEqual({ name: 'support-program-search', from_time: from, to_time: to })
  })

  it('상세 페이지 이동은 별도 커서를 사용하고 목록의 커서를 보존한다', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...detail, next_cursor: 'stage-2' })).mockResolvedValue(json({ ...detail, observations: [child] }))
    vi.stubGlobal('fetch', fetch)
    mount(`/ops/traces/${traceId}?${new URLSearchParams({ from_time: from, to_time: to, cursor: 'list-2' })}`)
    await screen.findByRole('region', { name: '실행 단계' })
    fireEvent.click(screen.getByRole('button', { name: '다음 단계' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe(`/api/v1/ops/traces/${traceId}?cursor=stage-2`)
    const back = new URL(screen.getByRole('link', { name: '← 조회하던 실행 목록으로' }).getAttribute('href')!, 'https://govbiz.test')
    expect(back.searchParams.get('cursor')).toBe('list-2')
    expect(back.searchParams.has('detail_cursor')).toBe(false)
  })

  it.each(['/ops/traces', `/ops/traces/${traceId}`])('%s 조회 장애를 빈 결과로 숨기지 않고 재조회한다', async (url) => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ detail: 'upstream failure' }, 503)).mockResolvedValue(json(url.endsWith(traceId) ? detail : page))
    vi.stubGlobal('fetch', fetch)
    mount(url)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('AI 실행 추적 서버에 연결할 수 없습니다.')
    expect(screen.queryByText('이 기간에 기록된 실행이 없습니다.')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: '다시 조회' }))
    await screen.findByRole('region', { name: url.endsWith(traceId) ? '실행 단계' : 'AI 실행 목록' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([401, 403])('목록과 상세의 %s 응답은 기존 관리자 인증을 다시 확인한다', async (status) => {
    const expired = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)))
    const list = mount('/ops/traces', expired)
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('region', { name: 'AI 실행 목록' })).toBeNull()
    list.unmount()
    mount(`/ops/traces/${traceId}`, expired)
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: '실행 단계' })).toBeNull()
  })

  it('다른 추적 ID의 상세 응답을 화면에 노출하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...detail, trace_id: 'another-trace' })))
    mount(`/ops/traces/${traceId}`)
    expect((await screen.findByRole('alert')).textContent).toContain('AI 실행 추적 응답을 확인할 수 없습니다.')
    expect(screen.queryByText(child.output)).toBeNull()
  })
})
