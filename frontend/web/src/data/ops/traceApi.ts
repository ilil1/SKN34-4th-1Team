import { z } from 'zod'
import { OpsApiError } from './opsApi'

const timestamp = z.iso.datetime({ offset: true })
const traceSchema = z.object({
  id: z.string().min(1), trace_id: z.string().min(1), name: z.string(), type: z.string().min(1),
  started_at: timestamp, ended_at: timestamp.nullable(), level: z.string(), status_message: z.string().nullable(), model: z.string().nullable(),
  latency_seconds: z.number().nonnegative().nullable(), total_cost: z.number().nonnegative().nullable(), environment: z.string().nullable(),
})
const tracePageSchema = z.object({ results: z.array(traceSchema), next_cursor: z.string().nullable(), from_time: timestamp, to_time: timestamp })
const traceDetailSchema = z.object({
  trace_id: z.string().min(1), next_cursor: z.string().nullable(),
  observations: z.array(traceSchema.extend({
    parent_observation_id: z.string().nullable(), input: z.string().nullable(), output: z.string().nullable(),
    metadata: z.unknown(), usage_details: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  })),
})
export type TraceSummary = z.infer<typeof traceSchema>
export type TracePage = z.infer<typeof tracePageSchema>
export type TraceDetail = z.infer<typeof traceDetailSchema>
export type TraceFilters = { name?: string; from_time?: string; to_time?: string; cursor?: string }

async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1/ops/traces${path}`, {
      credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new OpsApiError('AI 실행 추적 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.', 0)
  }
  if (!response.ok) {
    const message = response.status === 401 ? '로그인이 만료되었습니다.'
      : response.status === 403 ? '관리자 계정만 AI 실행 추적을 볼 수 있습니다.'
      : response.status === 404 ? '해당 실행 추적을 찾을 수 없습니다.'
      : response.status === 400 ? '조회 조건이 올바르지 않습니다. 기간과 필터를 다시 선택하세요.'
      : 'AI 실행 추적 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.'
    throw new OpsApiError(message, response.status)
  }
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new OpsApiError('AI 실행 추적 응답을 확인할 수 없습니다. 다시 조회하세요.', response.status)
  return parsed.data
}

export function listTraces(filters: TraceFilters, signal?: AbortSignal) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(filters)) if (value) query.set(name, value)
  return read(query.size ? `?${query}` : '', tracePageSchema, signal)
}

export function getTrace(traceId: string, cursor?: string, signal?: AbortSignal) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
  return read(`/${encodeURIComponent(traceId)}${query}`, traceDetailSchema.refine((value) => value.trace_id === traceId
    && value.observations.every((item) => item.trace_id === traceId)), signal)
}
