import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecurrenceDraft, RecurrenceSeriesItem } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { formatDate } from '../utils/date'

const weekdayNames = ['一', '二', '三', '四', '五', '六', '日']

export function RecurrencesPage({ today }: { today: string }) {
  const series = useQuery({ queryKey: ['recurrences'], queryFn: todoClient.recurrences.list })
  const [editor, setEditor] = useState<RecurrenceSeriesItem | 'NEW' | null>(null)
  const [enableChange, setEnableChange] = useState<RecurrenceSeriesItem | null>(null)
  return <div className="page">
    <PageHeader title="重复系列" actions={<button className="button button--primary" type="button" onClick={() => setEditor('NEW')}>＋ 新建重复系列</button>} />
    {series.isLoading ? <LoadingState label="正在读取重复系列…" /> : series.isError ? <ErrorState error={series.error} onRetry={() => series.refetch()} /> : series.data?.length ? <div className="series-list">{series.data.map((item) => <SeriesCard series={item} today={today} onEdit={() => setEditor(item)} onToggle={() => setEnableChange(item)} key={item.id} />)}</div> : <EmptyState icon="↻" title="还没有重复系列" action={<button className="button button--primary" type="button" onClick={() => setEditor('NEW')}>创建第一个系列</button>} />}
    <SeriesEditor open={Boolean(editor)} series={editor === 'NEW' ? null : editor} today={today} onClose={() => setEditor(null)} />
    <EnableSeriesModal series={enableChange} today={today} onClose={() => setEnableChange(null)} />
  </div>
}

function SeriesCard({ series, today, onEdit, onToggle }: { series: RecurrenceSeriesItem; today: string; onEdit: () => void; onToggle: () => void }) {
  return <article className={series.enabled ? 'series-card' : 'series-card is-disabled'}>
    <div className="series-card__icon">↻</div>
    <div className="series-card__main"><header><span className={series.enabled ? 'status-pill status-pill--active' : 'status-pill'}>{series.enabled ? '启用中' : '已停用'}</span>{series.project && <span className="tag tag--neutral">{series.project.name}</span>}</header><h3>{series.title}</h3>{series.notes && <p>{series.notes}</p>}<div className="series-card__rule"><strong>{ruleLabel(series)}</strong><span>{formatDate(series.startOn, { year: false })} 开始{series.endOn ? ` · ${formatDate(series.endOn, { year: false })} 结束` : ' · 不设结束日'}</span></div></div>
    <div className="series-card__attributes"><span className={series.important ? 'is-on' : ''}>重要</span><span className={series.urgent ? 'is-on is-urgent' : ''}>紧急</span></div>
    <div className="series-card__actions"><button className="button button--ghost" type="button" onClick={onEdit}>修改规则</button><button className={series.enabled ? 'button button--secondary' : 'button button--primary'} type="button" onClick={onToggle}>{series.enabled ? '停用' : '重新启用'}</button>{series.enabled && series.startOn > today && <small>尚未开始</small>}</div>
  </article>
}

function SeriesEditor({ open, series, today, onClose }: { open: boolean; series: RecurrenceSeriesItem | null; today: string; onClose: () => void }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list, enabled: open })
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [busy, setBusy] = useState(false)
  return <Modal open={open} title={series ? '修改重复系列' : '新建重复系列'} description={series ? '从指定生效日（包含当天）重新计算未来安排。' : undefined} size="large" onClose={onClose}><SeriesForm key={series?.id ?? 'new'} series={series} projects={projects.data ?? []} today={today} busy={busy} onCancel={onClose} onSubmit={async (draft, effectiveOn) => { setBusy(true); try { if (series) await todoClient.recurrences.update(series, draft, effectiveOn); else await todoClient.recurrences.create(draft); notify(series ? `新规则将从 ${effectiveOn} 生效` : '重复系列已创建', 'success'); await queryClient.invalidateQueries(); onClose() } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) } }} /></Modal>
}

function SeriesForm({ series, projects, today, busy, onCancel, onSubmit }: { series: RecurrenceSeriesItem | null; projects: Array<{ id: string; name: string; status: string }>; today: string; busy: boolean; onCancel: () => void; onSubmit: (draft: RecurrenceDraft, effectiveOn: string) => void }) {
  const [title, setTitle] = useState(series?.title ?? '')
  const [notes, setNotes] = useState(series?.notes ?? '')
  const [projectId, setProjectId] = useState(series?.project?.id ?? '')
  const [important, setImportant] = useState(series?.important ?? false)
  const [urgent, setUrgent] = useState(series?.urgent ?? false)
  const [startOn, setStartOn] = useState(series?.startOn ?? today)
  const [endOn, setEndOn] = useState(series?.endOn ?? '')
  const [kind, setKind] = useState<RecurrenceDraft['ruleKind']>(series?.ruleKind ?? 'DAILY')
  const [weekdays, setWeekdays] = useState<number[]>(series?.weekdays.length ? series.weekdays : [1])
  const [monthlyDay, setMonthlyDay] = useState(series?.monthlyDay ?? 1)
  const [effectiveOn, setEffectiveOn] = useState(today)
  const [error, setError] = useState('')
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!title.trim()) { setError('请输入系列标题'); return } if (endOn && endOn < startOn) { setError('结束日不能早于开始日'); return } if (kind === 'WEEKLY' && !weekdays.length) { setError('每周规则至少选择一个星期'); return } if (series && effectiveOn < today) { setError('修改生效日只能是今天或未来'); return } onSubmit({ title: title.trim(), notes: notes.trim() || null, projectId: projectId || null, important, urgent, startOn, endOn: endOn || null, ruleKind: kind, weekdays: kind === 'WEEKLY' ? weekdays : [], monthlyDay: kind === 'MONTHLY' ? monthlyDay : null }, effectiveOn) }
  return <form className="series-form" onSubmit={submit}>
    {series && <div className="effective-callout"><span>从哪天开始应用新规则？</span><input type="date" min={today} value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} /><small>该日及之后已安排但未单独处理的未来规则会被替换。</small></div>}
    <div className="form-grid"><label className="field field--full"><span>系列标题 <b>*</b></span><input autoFocus value={title} onChange={(event) => { setTitle(event.target.value); setError('') }} /></label><label className="field field--full"><span>备注</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="每个新实例都会复制这段备注" /></label><label className="field"><span>所属项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">无项目</option>{projects.filter((project) => project.status === 'ACTIVE' || project.id === projectId).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><div className="field"><span>四象限属性</span><div className="inline-toggles"><label className={important ? 'is-active' : ''}><input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} />重要</label><label className={urgent ? 'is-active is-urgent' : ''}><input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />紧急</label></div></div><label className="field"><span>开始日（包含当天）</span><input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} /></label><label className="field"><span>结束日（可选，包含当天）</span><input type="date" min={startOn} value={endOn} onChange={(event) => setEndOn(event.target.value)} /></label></div>
    <fieldset className="recurrence-pattern"><legend>重复频率</legend><div className="pattern-tabs">{([['DAILY', '每日'], ['WEEKLY', '每周'], ['MONTHLY', '每月']] as const).map(([value, label]) => <label className={kind === value ? 'is-active' : ''} key={value}><input type="radio" name="pattern" checked={kind === value} onChange={() => setKind(value)} />{label}</label>)}</div>{kind === 'WEEKLY' && <div className="weekday-picker">{weekdayNames.map((label, index) => { const value = index + 1; return <label className={weekdays.includes(value) ? 'is-active' : ''} key={value}><input type="checkbox" checked={weekdays.includes(value)} onChange={(event) => setWeekdays((current) => event.target.checked ? [...current, value].sort() : current.filter((day) => day !== value))} />周{label}</label> })}</div>}{kind === 'MONTHLY' && <div className="monthly-picker"><span>每月</span><input type="number" min="1" max="31" value={monthlyDay} onChange={(event) => setMonthlyDay(Math.max(1, Math.min(31, Number(event.target.value))))} /><span>日</span><small>当月没有该日时，安排在当月最后一天。</small></div>}</fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button button--ghost" type="button" onClick={onCancel}>取消</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? '保存中…' : series ? '保存并按生效日更新' : '创建系列'}</button></div>
  </form>
}

function EnableSeriesModal({ series, today, onClose }: { series: RecurrenceSeriesItem | null; today: string; onClose: () => void }) {
  const [effectiveOn, setEffectiveOn] = useState(today)
  const [busy, setBusy] = useState(false)
  const { notify } = useFeedback()
  const queryClient = useQueryClient()
  const enabling = series ? !series.enabled : false
  return <Modal open={Boolean(series)} title={enabling ? '重新启用重复系列' : '停用重复系列'} description={enabling ? '从生效日起恢复产生新实例。' : '生效日及之后不再产生新实例；历史与例外实例都会保留。'} onClose={onClose} size="small"><label className="field"><span>生效日（包含当天）</span><input type="date" min={today} value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} /></label><div className="modal-actions"><button className="button button--ghost" type="button" onClick={onClose}>取消</button><button className={enabling ? 'button button--primary' : 'button button--danger'} type="button" disabled={busy} onClick={async () => { if (!series) return; setBusy(true); try { await todoClient.recurrences.setEnabled(series, enabling, effectiveOn); notify(enabling ? '重复系列已重新启用' : '重复系列已按计划停用', 'success'); await queryClient.invalidateQueries(); onClose() } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) } }}>{busy ? '处理中…' : enabling ? '确认启用' : '确认停用'}</button></div></Modal>
}

function ruleLabel(series: RecurrenceSeriesItem): string {
  if (series.ruleKind === 'DAILY') return '每天'
  if (series.ruleKind === 'WEEKLY') return `每周 ${series.weekdays.map((day) => weekdayNames[day - 1]).map((day) => `周${day}`).join('、')}`
  return `每月 ${series.monthlyDay} 日${(series.monthlyDay ?? 0) >= 29 ? '（短月自动落到月末）' : ''}`
}
