import { adminAiCostMaxDays, type NewAdminAiModelPrice } from '../entities/AdminAiCost'
import type { AdminAiCostRepository } from '../repositories/AdminAiCostRepository'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** 기간이 거꾸로이거나 너무 길면 화면이 고칠 수 있게 사유를 돌려줍니다. */
export type AdminAiCostPeriodIssue = 'invalid-date' | 'reversed-period' | 'too-long'

export function adminAiCostPeriodIssue(from: string, to: string): AdminAiCostPeriodIssue | null {
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'invalid-date'
  if (from > to) return 'reversed-period'
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
  return days > adminAiCostMaxDays ? 'too-long' : null
}

/** UTC 날짜 기간의 앱 사용량과 OpenAI 추정·실제 비용을 읽습니다. */
export class GetAdminAiCostSummaryUseCase {
  private readonly repository: Pick<AdminAiCostRepository, 'getSummary'>

  constructor(repository: Pick<AdminAiCostRepository, 'getSummary'>) {
    this.repository = repository
  }

  execute(from: string, to: string, signal?: AbortSignal) {
    const issue = adminAiCostPeriodIssue(from, to)
    if (issue !== null) throw new RangeError(issue)
    return this.repository.getSummary(from, to, signal)
  }
}

/** OpenAI Usage·Costs API에서 같은 UTC 기간의 사용량과 실제 비용을 함께 가져옵니다. */
export class SyncAdminAiCostsUseCase {
  private readonly repository: Pick<AdminAiCostRepository, 'sync'>

  constructor(repository: Pick<AdminAiCostRepository, 'sync'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal) {
    return this.repository.sync(signal)
  }
}

export class GetAdminAiModelPricesUseCase {
  private readonly repository: Pick<AdminAiCostRepository, 'getPrices'>

  constructor(repository: Pick<AdminAiCostRepository, 'getPrices'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal) {
    return this.repository.getPrices(signal)
  }
}

/** 가격은 고치지 않고 시작일이 다른 새 가격으로 더합니다. 모델 이름은 소문자로, 빈 비고는 없음으로 보냅니다. */
export class AddAdminAiModelPriceUseCase {
  private readonly repository: Pick<AdminAiCostRepository, 'addPrice'>

  constructor(repository: Pick<AdminAiCostRepository, 'addPrice'>) {
    this.repository = repository
  }

  execute(price: NewAdminAiModelPrice, signal?: AbortSignal) {
    const note = price.note?.trim() ?? ''
    return this.repository.addPrice({
      ...price,
      modelPrefix: price.modelPrefix.trim().toLowerCase(),
      cachedInputUsdPerMillion: price.cachedInputUsdPerMillion?.trim() || null,
      cacheWriteInputUsdPerMillion: price.cacheWriteInputUsdPerMillion?.trim() || null,
      cacheWrite12hInputUsdPerMillion: price.cacheWrite12hInputUsdPerMillion?.trim() || null,
      note: note === '' ? null : note,
    }, signal)
  }
}
