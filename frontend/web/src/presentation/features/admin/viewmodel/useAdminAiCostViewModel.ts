import { type FormEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import {
  adminAiCostMaxDays,
  aiServiceTierLabels,
  aiUsageFeatureLabel,
  defaultAdminAiCostPeriod,
  formatAiCostUsd,
  type AdminAiCostSummary,
  type AdminAiCostComparison,
  type AdminAiModelPrice,
  type AiServiceTier,
  type AiUsageTotals,
} from '../../../../domain/entities/AdminAiCost'
import { planLabels, type PlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import {
  adminAiCostPeriodIssue,
  type AddAdminAiModelPriceUseCase,
  type GetAdminAiCostSummaryUseCase,
  type GetAdminAiModelPricesUseCase,
  type SyncAdminAiCostsUseCase,
} from '../../../../domain/usecases/AdminAiCostUseCases'
import { signedOut } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { adminAccessFailure, adminAccessMessages } from './adminAccountAccess'
import { formatAdminDateTime } from './adminAccountFormat'

type UseCases = {
  getSummary: Pick<GetAdminAiCostSummaryUseCase, 'execute'>
  sync: Pick<SyncAdminAiCostsUseCase, 'execute'>
  getPrices: Pick<GetAdminAiModelPricesUseCase, 'execute'>
  addPrice: Pick<AddAdminAiModelPriceUseCase, 'execute'>
}

export const adminAiCostMessages = {
  failed: 'AI 비용을 불러오지 못했어요.',
  loading: 'AI 비용을 불러오는 중이에요.',
  period: {
    'invalid-date': '날짜를 다시 골라 주세요.',
    'reversed-period': '시작일이 종료일보다 늦어요. 기간을 다시 골라 주세요.',
    'too-long': `한 번에 ${adminAiCostMaxDays}일까지 볼 수 있어요.`,
  },
  basis: '비용 비교는 OpenAI에서 함께 가져온 사용량과 실제 비용을 같은 UTC 날짜로 맞춰요. 하루는 서울 오전 9시에 시작해요. '
    + '선택된 OpenAI 프로젝트·조직 범위의 Core 밖 호출도 포함하지만, 기능·회원별 내역은 앱이 직접 기록한 호출만 보여 줘요. '
    + 'OpenAI 집계가 늦게 반영될 수 있어, 가져온 비용은 최종 청구 금액이 아니에요.',
  actualMissingKey: 'OpenAI 조직 관리자 키(OPENAI_ADMIN_KEY)가 없어 실제 비용을 가져올 수 없어요. 프로젝트 키로는 조회되지 않아요.',
  actualNeverFetched: '아직 같은 기간의 OpenAI 사용량과 실제 비용을 함께 가져오지 않았어요.',
  comparisonIncomplete: '선택 기간에 함께 수집되지 않은 날짜가 있어 차이를 계산하지 않아요. 사용량·비용을 다시 가져와 주세요.',
  comparisonUnpriced: '가격이나 사용량이 미확인인 호출이 있어 차이를 계산하지 않아요.',
  currentDay: '진행 중인 UTC 날짜를 포함해요. 이후 호출과 지연 집계로 값이 바뀔 수 있어요.',
  sync: {
    done: (lines: number, usd: string) => `OpenAI 사용량과 실제 비용 ${lines}줄(합계 $${usd})을 함께 가져왔어요.`,
    'admin-key-missing': 'OpenAI 조직 관리자 키가 설정되지 않았어요.',
    'admin-key-rejected': 'OpenAI가 관리자 키를 거절했어요. 조직 관리자 키인지 확인해 주세요.',
    unavailable: 'OpenAI 사용량·비용을 함께 가져오지 못했어요. 기존 값은 그대로 두었어요.',
    failed: '사용량·비용을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
  price: {
    added: '가격을 더했어요. UTC 시작일부터 새 앱 요청에 적용해요. OpenAI 사용량은 다음 동기화에서 다시 계산해요.',
    conflict: '같은 모델·처리 등급·시작일의 가격이 이미 있어요.',
    invalid: '모델 이름(소문자)·처리 등급·0 이상의 가격·시작일을 확인해 주세요.',
    failed: '가격을 더하지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
} as const

type PriceForm = {
  modelPrefix: string
  serviceTier: AiServiceTier
  inputUsdPerMillion: string
  cachedInputUsdPerMillion: string
  cacheWriteInputUsdPerMillion: string
  cacheWrite12hInputUsdPerMillion: string
  outputUsdPerMillion: string
  effectiveFrom: string
  note: string
}

const emptyPriceForm = (today: string): PriceForm => ({
  modelPrefix: '', serviceTier: 'default', inputUsdPerMillion: '', cachedInputUsdPerMillion: '',
  cacheWriteInputUsdPerMillion: '', cacheWrite12hInputUsdPerMillion: '', outputUsdPerMillion: '', effectiveFrom: today, note: '',
})

function tokens(totals: AiUsageTotals): string {
  const cacheWrites = totals.cacheWriteInputTokens === null || totals.cacheWrite12hInputTokens === null
    ? '캐시 쓰기 미확인'
    : `캐시 쓰기 ${totals.cacheWriteInputTokens.toLocaleString('ko-KR')} · 12시간 쓰기 ${totals.cacheWrite12hInputTokens.toLocaleString('ko-KR')}`
  return `입력 ${totals.inputTokens.toLocaleString('ko-KR')} (캐시 읽기 ${totals.cachedInputTokens.toLocaleString('ko-KR')} · ${cacheWrites})`
    + ` · 출력 ${totals.outputTokens.toLocaleString('ko-KR')}`
}

function unpriced(totals: AiUsageTotals): string | null {
  const notes = [
    totals.unpricedCalls > 0 ? `비용 미확정 호출 ${totals.unpricedCalls}회 제외` : null,
    totals.incompleteUsageCalls > 0 ? `사용량 미확인 ${totals.incompleteUsageCalls}회` : null,
  ].filter(Boolean)
  return notes.length > 0 ? notes.join(' · ') : null
}

function estimatedCost(totals: AiUsageTotals, rate: string | null = null): string {
  if (totals.calls > 0 && (totals.unpricedCalls === totals.calls || totals.incompleteUsageCalls === totals.calls)) return '미확정'
  return formatAiCostUsd(totals.estimatedUsd, rate)
}

function estimatedCostWithNote(totals: AiUsageTotals, rate: string | null = null): string {
  const cost = estimatedCost(totals, rate)
  const note = unpriced(totals)
  return note === null ? cost : `${cost} · ${note}`
}

/** 동일 기간의 제공처 스냅샷에서 모든 금액을 계산할 수 있을 때만 차이를 보입니다. */
function difference(comparison: AdminAiCostComparison | null): string | null {
  if (comparison?.status !== 'ready' || comparison.actualUsd === null || comparison.totals === null
    || comparison.totals.unpricedCalls > 0 || comparison.totals.incompleteUsageCalls > 0) return null
  const diff = Number(comparison.actualUsd) - Number(comparison.totals.estimatedUsd)
  const sign = diff >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(diff).toFixed(6)}`
}

/**
 * 관리자 AI 비용 화면의 대표 ViewModel입니다. 기간(UTC 날짜)의 제공처 비용 비교, 앱 기능·모델·회원별 합계, 가격표와 가격 추가,
 * 사용량·비용 동기화를 맡습니다. 세션이 끝났으면(401) 로그인 상태를 비우고, 권한이 없으면(403) 권한 안내를 보여 줍니다.
 */
export function useAdminAiCostViewModel(useCases: Partial<UseCases> = {}, now: () => number = Date.now) {
  const [resolved] = useState<UseCases>(() => ({
    getSummary: useCases.getSummary ?? appContainer.resolve('getAdminAiCostSummaryUseCase'),
    sync: useCases.sync ?? appContainer.resolve('syncAdminAiCostsUseCase'),
    getPrices: useCases.getPrices ?? appContainer.resolve('getAdminAiModelPricesUseCase'),
    addPrice: useCases.addPrice ?? appContainer.resolve('addAdminAiModelPriceUseCase'),
  }))
  const dispatch = useAppDispatch()
  const [initial] = useState(() => defaultAdminAiCostPeriod(now()))
  const [form, setForm] = useState(initial)
  const [period, setPeriod] = useState(initial)
  const [formError, setFormError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'forbidden' | 'signed-out'>('loading')
  const [summary, setSummary] = useState<AdminAiCostSummary | null>(null)
  const [prices, setPrices] = useState<AdminAiModelPrice[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [priceForm, setPriceForm] = useState<PriceForm>(() => emptyPriceForm(initial.to))
  const [priceError, setPriceError] = useState<string | null>(null)
  const [savingPrice, setSavingPrice] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setPhase('loading')
    void Promise.all([
      resolved.getSummary.execute(period.from, period.to, controller.signal),
      resolved.getPrices.execute(controller.signal),
    ]).then(([nextSummary, nextPrices]) => {
      if (controller.signal.aborted) return
      setSummary(nextSummary)
      setPrices(nextPrices)
      setPhase('ready')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const access = adminAccessFailure(error)
      if (access === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setPhase(access === 'forbidden' ? 'forbidden' : 'failed')
    })
    return () => controller.abort()
  }, [period, version, resolved, dispatch])

  function submitPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const issue = adminAiCostPeriodIssue(form.from, form.to)
    if (issue !== null) {
      setFormError(adminAiCostMessages.period[issue])
      return
    }
    setFormError(null)
    if (form.from === period.from && form.to === period.to) setVersion((value) => value + 1)
    else setPeriod({ ...form })
  }

  async function syncActual() {
    if (syncing) return
    setSyncing(true)
    setNotice(null)
    try {
      const result = await resolved.sync.execute()
      if (!isMounted.current) return
      if (result.outcome === 'done') {
        setNotice(adminAiCostMessages.sync.done(result.lines, result.amountUsd))
        setVersion((value) => value + 1)
      } else {
        setNotice(adminAiCostMessages.sync[result.outcome])
      }
    } catch (error) {
      if (!isMounted.current) return
      if (adminAccessFailure(error) === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setNotice(adminAccessFailure(error) === 'forbidden' ? adminAccessMessages.forbidden : adminAiCostMessages.sync.failed)
    } finally {
      if (isMounted.current) setSyncing(false)
    }
  }

  async function submitPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingPrice) return
    const values = priceForm
    if (values.modelPrefix.trim() === '' || values.inputUsdPerMillion.trim() === '' || values.outputUsdPerMillion.trim() === '') {
      setPriceError(adminAiCostMessages.price.invalid)
      return
    }
    setSavingPrice(true)
    setPriceError(null)
    try {
      const result = await resolved.addPrice.execute({
        modelPrefix: values.modelPrefix,
        serviceTier: values.serviceTier,
        inputUsdPerMillion: values.inputUsdPerMillion.trim(),
        cachedInputUsdPerMillion: values.cachedInputUsdPerMillion.trim() || null,
        cacheWriteInputUsdPerMillion: values.cacheWriteInputUsdPerMillion.trim() || null,
        cacheWrite12hInputUsdPerMillion: values.cacheWrite12hInputUsdPerMillion.trim() || null,
        outputUsdPerMillion: values.outputUsdPerMillion.trim(),
        effectiveFrom: values.effectiveFrom,
        note: values.note,
      })
      if (!isMounted.current) return
      if (result.outcome === 'done') {
        setPrices((current) => [...current, result.price])
        setPriceForm(emptyPriceForm(initial.to))
        setNotice(adminAiCostMessages.price.added)
      } else {
        setPriceError(adminAiCostMessages.price[result.outcome])
      }
    } catch (error) {
      if (!isMounted.current) return
      if (adminAccessFailure(error) === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setPriceError(adminAccessFailure(error) === 'forbidden' ? adminAccessMessages.forbidden : adminAiCostMessages.price.failed)
    } finally {
      if (isMounted.current) setSavingPrice(false)
    }
  }

  const rate = summary?.krwPerUsd ?? null
  const comparison = summary?.comparison ?? null
  const comparisonTotals = comparison?.totals ?? null
  const comparisonNote = comparison === null || comparison.status === 'not-synced'
    ? summary?.actualConfigured ? adminAiCostMessages.actualNeverFetched : adminAiCostMessages.actualMissingKey
    : comparison.status === 'incomplete' ? adminAiCostMessages.comparisonIncomplete
      : comparisonTotals !== null && (comparisonTotals.unpricedCalls > 0 || comparisonTotals.incompleteUsageCalls > 0)
        ? adminAiCostMessages.comparisonUnpriced : null
  return {
    phase,
    retry: () => setVersion((value) => value + 1),
    notice,
    dismissNotice: () => setNotice(null),
    basis: adminAiCostMessages.basis,
    comparisonNote,
    comparisonPeriod: comparison === null ? null : `${comparison.from} ~ ${comparison.to} · UTC`,
    currentDayNote: comparison?.includesCurrentDay ? adminAiCostMessages.currentDay : null,
    applicationTitle: comparison === null ? '앱에서 기록한 사용량 · 서버 집계 기준' : '앱에서 기록한 사용량 · UTC',
    form: {
      values: form,
      updateFrom: (value: string) => { setForm((current) => ({ ...current, from: value })); setFormError(null) },
      updateTo: (value: string) => { setForm((current) => ({ ...current, to: value })); setFormError(null) },
      submit: submitPeriod,
      error: formError,
    },
    stats: summary === null ? [] : [
      { label: '추정 비용(OpenAI 사용량)', value: comparisonTotals === null ? '—' : estimatedCost(comparisonTotals, rate), note: comparisonTotals === null ? null : unpriced(comparisonTotals) },
      {
        label: '실제 비용(OpenAI)',
        value: comparison?.actualUsd == null ? '—' : formatAiCostUsd(comparison.actualUsd, rate),
        note: comparison?.fetchedAt == null ? null : `${formatAdminDateTime(comparison.fetchedAt)} UTC 함께 가져옴`,
      },
      { label: '차이(실제 − 추정)', value: difference(comparison) ?? '—', note: null },
      { label: 'OpenAI 호출', value: comparisonTotals === null ? '—' : `${comparisonTotals.calls.toLocaleString('ko-KR')}회`, note: comparisonTotals === null ? null : tokens(comparisonTotals) },
    ],
    applicationStats: summary === null ? [] : [
      { label: '앱 기록 추정 비용', value: estimatedCost(summary.totals, rate), note: unpriced(summary.totals) },
      { label: '앱 기록 호출', value: `${summary.totals.calls.toLocaleString('ko-KR')}회`, note: tokens(summary.totals) },
    ],
    sync: {
      configured: summary?.actualConfigured ?? false,
      busy: syncing,
      run: () => void syncActual(),
    },
    byFeature: (summary?.byFeature ?? []).map((group) => ({
      key: group.key ?? 'system',
      label: aiUsageFeatureLabel(group.key),
      calls: `${group.totals.calls.toLocaleString('ko-KR')}회`,
      tokens: tokens(group.totals),
      cost: estimatedCost(group.totals, rate),
      note: unpriced(group.totals),
    })),
    byModel: (summary?.byModel ?? []).map((group) => ({
      key: `${group.key}:${group.serviceTier}`,
      label: group.key,
      tier: group.serviceTier in aiServiceTierLabels ? aiServiceTierLabels[group.serviceTier as AiServiceTier] : group.serviceTier,
      calls: `${group.totals.calls.toLocaleString('ko-KR')}회`,
      tokens: tokens(group.totals),
      cost: estimatedCostWithNote(group.totals, rate),
    })),
    days: (comparison?.days ?? []).filter((day) => day.totals.calls > 0 || day.actualUsd !== null)
      .sort((left, right) => right.date.localeCompare(left.date)).map((day) => ({
      date: day.date,
      calls: `${day.totals.calls.toLocaleString('ko-KR')}회`,
      estimated: estimatedCostWithNote(day.totals),
      actual: day.actualUsd === null ? '—' : formatAiCostUsd(day.actualUsd),
    })),
    topAccounts: (summary?.topAccounts ?? []).map((account) => ({
      id: account.accountId,
      email: account.email,
      path: `${appPaths.adminAccountDetail}?accountId=${account.accountId}`,
      plan: account.planCode !== null && account.planCode in planLabels ? planLabels[account.planCode as PlanCode] : '무료',
      calls: `${account.totals.calls.toLocaleString('ko-KR')}회`,
      cost: estimatedCostWithNote(account.totals, rate),
    })),
    prices: prices.map((price) => ({
      id: price.id,
      model: price.modelPrefix,
      tier: aiServiceTierLabels[price.serviceTier],
      input: `$${price.inputUsdPerMillion}`,
      cached: price.cachedInputUsdPerMillion === null ? '—' : `$${price.cachedInputUsdPerMillion}`,
      cacheWrite: price.cacheWriteInputUsdPerMillion === null ? '미등록' : `$${price.cacheWriteInputUsdPerMillion}`,
      cacheWrite12h: price.cacheWrite12hInputUsdPerMillion === null ? '미등록' : `$${price.cacheWrite12hInputUsdPerMillion}`,
      output: `$${price.outputUsdPerMillion}`,
      effectiveFrom: price.effectiveFrom,
      note: price.note ?? '',
    })),
    priceForm: {
      values: priceForm,
      tierOptions: (Object.keys(aiServiceTierLabels) as AiServiceTier[]).map((tier) => ({ value: tier, label: aiServiceTierLabels[tier] })),
      update: (field: keyof PriceForm, value: string) => {
        setPriceForm((current) => ({ ...current, [field]: value }))
        setPriceError(null)
      },
      submit: submitPrice,
      error: priceError,
      busy: savingPrice,
    },
  }
}
