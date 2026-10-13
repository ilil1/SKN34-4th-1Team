import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router'

import { SelectField } from '../../../shared/workspace/SelectField'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { adminAccessMessages } from '../viewmodel/adminAccountAccess'
import { adminAiCostMessages, useAdminAiCostViewModel } from '../viewmodel/useAdminAiCostViewModel'
import { adminAccountsPageStyles } from './AdminAccountsPage.styles'
import { adminAiCostsPageStyles as styles } from './AdminAiCostsPage.styles'

type ViewModel = ReturnType<typeof useAdminAiCostViewModel>

/**
 * 관리자 AI 비용입니다. 동일 UTC 기간에 함께 수집한 OpenAI 사용량 추정·실제 비용을 비교하고 앱 기록을 별도로 나눠 봅니다.
 * 가격표는 고치지 않고 시작일이 다른 가격을 더합니다. 회원 이메일이 있어 이 화면을 열면 감사 기록에 남습니다.
 */
export function AdminAiCostsPage({ title = 'AI 비용', children, onExpired }: {
  title?: string
  children?: ReactNode
  onExpired?: () => void
} = {}) {
  const vm = useAdminAiCostViewModel()
  const form = vm.form
  useEffect(() => {
    if (vm.phase === 'signed-out') onExpired?.()
  }, [vm.phase, onExpired])

  return (
    <>
      <WorkspacePageHeader title={title} />

      <div className={workspacePageStyles.content}>
        {children}
        <p className={styles.intro}>{vm.basis}</p>

        {vm.notice ? (
          <p className={adminAccountsPageStyles.notice} role="status">
            <span>{vm.notice}</span>
            <button className={workspacePageStyles.quietLink} type="button" onClick={vm.dismissNotice}>닫기</button>
          </p>
        ) : null}

        <div className={styles.toolbar}>
          <form className={styles.filterForm} aria-label="기간" onSubmit={form.submit} noValidate>
            <label className={styles.field}>시작일
              <input className={styles.dateInput} type="date" name="from" value={form.values.from}
                max={form.values.to || undefined} onChange={(event) => form.updateFrom(event.target.value)} />
            </label>
            <label className={styles.field}>종료일
              <input className={styles.dateInput} type="date" name="to" value={form.values.to}
                min={form.values.from || undefined} onChange={(event) => form.updateTo(event.target.value)} />
            </label>
            <div className={styles.formActions}>
              <button className={workspacePageStyles.primaryButton} type="submit">조회</button>
            </div>
          </form>
          <button className={workspacePageStyles.secondaryButton} type="button" disabled={!vm.sync.configured || vm.sync.busy} onClick={vm.sync.run}>
            {vm.sync.busy ? '가져오는 중…' : '사용량·비용 가져오기'}
          </button>
        </div>
        {form.error ? <p className={styles.formError} role="alert">{form.error}</p> : null}

        {vm.phase === 'signed-out' ? (
          <p className={workspacePageStyles.emptyNote} role="status">로그인이 필요합니다.</p>
        ) : vm.phase === 'forbidden' ? (
          <p className={workspacePageStyles.emptyNote} role="alert">{adminAccessMessages.forbidden}</p>
        ) : vm.phase === 'failed' ? (
          <p className={workspacePageStyles.emptyNote} role="alert">
            {adminAiCostMessages.failed}{' '}
            <button className={workspacePageStyles.quietLink} type="button" onClick={vm.retry}>다시 시도</button>
          </p>
        ) : vm.phase === 'loading' ? (
          <p className={workspacePageStyles.emptyNote} role="status">{adminAiCostMessages.loading}</p>
        ) : (
          <CostSections vm={vm} />
        )}

        {vm.phase === 'ready' && <PriceSection vm={vm} />}
      </div>
    </>
  )
}

function CostSections({ vm }: { vm: ViewModel }) {
  return (
    <>
      <h2 className={workspacePageStyles.cardTitle}>OpenAI 비용 비교 · UTC</h2>
      {vm.comparisonPeriod ? <p className={styles.sectionNote}>{vm.comparisonPeriod}</p> : null}
      {vm.comparisonNote ? <p className={styles.sectionNote} role="status">{vm.comparisonNote}</p> : null}
      {vm.currentDayNote ? <p className={styles.sectionNote}>{vm.currentDayNote}</p> : null}
      <section className={adminAccountsPageStyles.statRow} aria-label="비용 요약">
        {vm.stats.map((stat) => (
          <div className={adminAccountsPageStyles.statCell} key={stat.label}>
            <span className={adminAccountsPageStyles.statLabel}>{stat.label}</span>
            <strong className={adminAccountsPageStyles.statValue}>{stat.value}</strong>
            {stat.note ? <span className={styles.statNote}>{stat.note}</span> : null}
          </div>
        ))}
      </section>

      <section className={workspacePageStyles.card} aria-label="날짜별">
        <h2 className={workspacePageStyles.cardTitle}>날짜별 OpenAI 비용</h2>
        <p className={styles.sectionNote}>추정과 실제 모두 UTC 하루(서울 오전 9시 시작) 기준이에요. 사용량은 동기화 때 함께 수집한 값이에요.</p>
        <Table head={['날짜(UTC)', '호출', '추정', '실제']} empty="이 기간에 함께 가져온 사용량·비용이 없어요."
          rows={vm.days.map((row) => ({ key: row.date, cells: [row.date, row.calls, row.estimated, row.actual] }))} />
      </section>

      <h2 className={workspacePageStyles.cardTitle}>{vm.applicationTitle}</h2>
      <p className={styles.sectionNote}>앱에 기록된 호출만 기능·모델·회원별로 나눠요. Core 밖 호출의 사용자·기능은 이 내역에 자동 연결되지 않아요.</p>
      <section className={adminAccountsPageStyles.statRow} aria-label="앱 사용량 요약">
        {vm.applicationStats.map((stat) => (
          <div className={adminAccountsPageStyles.statCell} key={stat.label}>
            <span className={adminAccountsPageStyles.statLabel}>{stat.label}</span>
            <strong className={adminAccountsPageStyles.statValue}>{stat.value}</strong>
            {stat.note ? <span className={styles.statNote}>{stat.note}</span> : null}
          </div>
        ))}
      </section>

      <div className={styles.sectionGrid}>
        <section className={workspacePageStyles.card} aria-label="기능별">
          <h2 className={workspacePageStyles.cardTitle}>기능별</h2>
          <Table head={['기능', '호출', '토큰', '추정 비용']} empty="이 기간에 기록된 AI 호출이 없어요."
            rows={vm.byFeature.map((row) => ({ key: row.key, cells: [row.label, row.calls, row.tokens, row.note ? `${row.cost} · ${row.note}` : row.cost] }))} />
        </section>
        <section className={workspacePageStyles.card} aria-label="모델별">
          <h2 className={workspacePageStyles.cardTitle}>모델별</h2>
          <Table head={['모델', '처리 등급', '호출', '토큰', '추정 비용']} empty="이 기간에 기록된 AI 호출이 없어요." modelColumn
            rows={vm.byModel.map((row) => ({ key: row.key, cells: [row.label, row.tier, row.calls, row.tokens, row.cost] }))} />
        </section>
      </div>

      <div className={styles.sectionGrid}>
        <section className={workspacePageStyles.card} aria-label="많이 쓴 회원">
          <h2 className={workspacePageStyles.cardTitle}>많이 쓴 회원</h2>
          {vm.topAccounts.length === 0 ? (
            <p className={styles.sectionNote}>회원에게 붙은 AI 호출이 없어요.</p>
          ) : (
            <div className={adminAccountsPageStyles.tableScroll} role="region" aria-label="많이 쓴 회원 표 가로 스크롤" tabIndex={0}>
              <table className={workspacePageStyles.table}>
                <thead><tr>{['회원', '요금제', '호출', '추정 비용'].map((label) => <th className={workspacePageStyles.tableHeadCell} key={label}>{label}</th>)}</tr></thead>
                <tbody>
                  {vm.topAccounts.map((row) => (
                    <tr key={row.id}>
                      <td className={workspacePageStyles.tableCell}><Link className={adminAccountsPageStyles.emailLink} to={row.path}>{row.email}</Link></td>
                      <td className={workspacePageStyles.tableCell}>{row.plan}</td>
                      <td className={`${workspacePageStyles.tableCell} ${styles.numberCell}`}>{row.calls}</td>
                      <td className={`${workspacePageStyles.tableCell} ${styles.numberCell}`}>{row.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function Table({ head, rows, empty, modelColumn = false }: {
  head: string[]
  rows: { key: string; cells: string[] }[]
  empty: string
  modelColumn?: boolean
}) {
  if (rows.length === 0) return <p className={styles.sectionNote}>{empty}</p>
  return (
    <div className={adminAccountsPageStyles.tableScroll} role="region" aria-label={`${head[0]} 표 가로 스크롤`} tabIndex={0}>
      <table className={workspacePageStyles.table}>
        <thead><tr>{head.map((label) => <th className={workspacePageStyles.tableHeadCell} key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td className={`${workspacePageStyles.tableCell} ${index === 0 ? (modelColumn ? styles.modelCell : '') : styles.numberCell}`} key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PriceSection({ vm }: { vm: ViewModel }) {
  const form = vm.priceForm
  return (
    <section className={workspacePageStyles.card} aria-label="가격표">
      <h2 className={workspacePageStyles.cardTitle}>가격표 (1M 토큰당 USD)</h2>
      <p className={styles.sectionNote}>모델 이름은 앞부분으로 맞춰 날짜가 붙은 모델에도 적용해요. 가격이 바뀌면 고치지 말고 새 시작일로 더해 주세요. 캐시 쓰기 단가가 비어 있으면 쓰기 비용을 확정하지 않아요.</p>
      <Table head={['모델', '처리 등급', '입력', '캐시 읽기', '캐시 쓰기', '12시간 캐시 쓰기', '출력', '시작일', '비고']} modelColumn
        empty={vm.phase === 'loading' ? '가격표를 불러오는 중이에요.' : '가격이 없어요.'}
        rows={vm.prices.map((row) => ({ key: String(row.id), cells: [row.model, row.tier, row.input, row.cached, row.cacheWrite, row.cacheWrite12h, row.output, row.effectiveFrom, row.note] }))} />
      <form className={styles.filterForm} aria-label="가격 추가" onSubmit={form.submit} noValidate>
        <label className={styles.field}>모델
          <input className={styles.textInput} type="text" name="modelPrefix" autoComplete="off" placeholder="gpt-5.6-luna"
            value={form.values.modelPrefix} onChange={(event) => form.update('modelPrefix', event.target.value)} />
        </label>
        <label className={styles.field}>처리 등급
          <SelectField className={styles.tierSelect} label="처리 등급" value={form.values.serviceTier}
            options={form.tierOptions} onChange={(value) => form.update('serviceTier', value)} />
        </label>
        <label className={styles.field}>입력
          <input className={styles.numberInput} type="text" inputMode="decimal" name="inputUsdPerMillion"
            value={form.values.inputUsdPerMillion} onChange={(event) => form.update('inputUsdPerMillion', event.target.value)} />
        </label>
        <label className={styles.field}>캐시 읽기
          <input className={styles.numberInput} type="text" inputMode="decimal" name="cachedInputUsdPerMillion"
            value={form.values.cachedInputUsdPerMillion} onChange={(event) => form.update('cachedInputUsdPerMillion', event.target.value)} />
        </label>
        <label className={styles.field}>캐시 쓰기
          <input className={styles.numberInput} type="text" inputMode="decimal" name="cacheWriteInputUsdPerMillion"
            value={form.values.cacheWriteInputUsdPerMillion} onChange={(event) => form.update('cacheWriteInputUsdPerMillion', event.target.value)} />
        </label>
        <label className={styles.field}>12시간 캐시 쓰기
          <input className={styles.numberInput} type="text" inputMode="decimal" name="cacheWrite12hInputUsdPerMillion"
            value={form.values.cacheWrite12hInputUsdPerMillion} onChange={(event) => form.update('cacheWrite12hInputUsdPerMillion', event.target.value)} />
        </label>
        <label className={styles.field}>출력
          <input className={styles.numberInput} type="text" inputMode="decimal" name="outputUsdPerMillion"
            value={form.values.outputUsdPerMillion} onChange={(event) => form.update('outputUsdPerMillion', event.target.value)} />
        </label>
        <label className={styles.field}>시작일
          <input className={styles.dateInput} type="date" name="effectiveFrom"
            value={form.values.effectiveFrom} onChange={(event) => form.update('effectiveFrom', event.target.value)} />
        </label>
        <label className={styles.field}>비고
          <input className={styles.textInput} type="text" name="note" maxLength={200}
            value={form.values.note} onChange={(event) => form.update('note', event.target.value)} />
        </label>
        <div className={styles.formActions}>
          <button className={workspacePageStyles.primaryButton} type="submit" disabled={form.busy}>{form.busy ? '더하는 중…' : '가격 추가'}</button>
        </div>
      </form>
      {form.error ? <p className={styles.formError} role="alert">{form.error}</p> : null}
    </section>
  )
}
