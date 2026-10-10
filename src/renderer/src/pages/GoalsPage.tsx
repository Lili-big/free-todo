import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GoalCategory, GoalDraft, GoalItem, GoalPeriodKind, GoalStatus, ProjectItem } from '../../domain'
import { TodoApiError, apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { ConfirmDialog, Modal } from '../components/Modal'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { formatDate } from '../utils/date'
import { addDays } from '../utils/date'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'

const statusLabels: Record<GoalStatus, string> = {
  ACTIVE: '进行中', PAUSED: '已暂停', REVIEW_REQUIRED: '待复盘', COMPLETED: '已完成', ABANDONED: '已放弃'
}

export function GoalsPage({ today }: { today: string }) {
  const [status, setStatus] = useState<GoalStatus | 'ALL'>('ALL')
  const [categoryId, setCategoryId] = useState('ALL')
  const [editor, setEditor] = useState<GoalItem | 'NEW' | null>(null)
  const [continueGoal, setContinueGoal] = useState<GoalItem | null>(null)
  const [categoryManager, setCategoryManager] = useState(false)
  const goals = useQuery({ queryKey: ['goals', status, categoryId], queryFn: () => todoClient.goals.list({ status, ...(categoryId === 'ALL' ? {} : { categoryId: categoryId === 'NONE' ? null : categoryId }) }) })
  const categories = useQuery({ queryKey: ['goal-categories'], queryFn: todoClient.categories.list })
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list })
  const groups = useMemo(() => {
    const order: Array<GoalItem['priority']> = ['P0', 'P1', 'P2', 'P3', null]
    return order.map((priority) => ({ priority, goals: (goals.data ?? []).filter((goal) => goal.priority === priority) })).filter((group) => group.goals.length)
  }, [goals.data])

  return (
    <div className="page">
      <PageHeader title="目标" actions={<><button className="button button--ghost" type="button" onClick={() => setCategoryManager(true)}>管理分类</button><button className="button button--primary" type="button" onClick={() => setEditor('NEW')}>＋ 新建目标</button></>} />
      <div className="toolbar toolbar--wrap">
        <div className="segmented">{([['ALL', '全部'], ['ACTIVE', '进行中'], ['REVIEW_REQUIRED', '待复盘'], ['PAUSED', '暂停'], ['COMPLETED', '完成'], ['ABANDONED', '放弃']] as const).map(([value, label]) => <button type="button" key={value} className={status === value ? 'is-active' : ''} onClick={() => setStatus(value)}>{label}</button>)}</div>
        <label className="toolbar-select"><span>分类</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="ALL">全部</option>{(categories.data ?? []).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}<option value="NONE">无分类</option></select></label>
      </div>
      {goals.isLoading ? <LoadingState /> : goals.isError ? <ErrorState error={goals.error} onRetry={() => goals.refetch()} /> : groups.length ? <div className="goal-groups">{groups.map((group) => <section className="goal-group" key={group.priority ?? 'unset'}><header><span className={`priority-badge priority-badge--${(group.priority ?? 'unset').toLowerCase()}`}>{group.priority ?? '未设置'}</span><em>{group.goals.length}</em></header><div className="goal-grid">{group.goals.map((goal) => <GoalCard goal={goal} projects={(projects.data ?? []).filter((project) => project.goal?.id === goal.id)} today={today} key={goal.id} onEdit={() => setEditor(goal)} onContinue={() => setContinueGoal(goal)} />)}</div></section>)}</div> : <EmptyState icon="◎" title={goals.data?.length ? '没有符合筛选的目标' : '还没有目标'} action={!goals.data?.length ? <button className="button button--primary" type="button" onClick={() => setEditor('NEW')}>创建第一个目标</button> : undefined} />}
      <GoalEditor open={Boolean(editor)} goal={editor === 'NEW' ? null : editor} categories={categories.data ?? []} today={today} onClose={() => setEditor(null)} />
      <ContinueGoalModal goal={continueGoal} today={today} onClose={() => setContinueGoal(null)} />
      <CategoryManager open={categoryManager} categories={categories.data ?? []} onClose={() => setCategoryManager(false)} />
    </div>
  )
}

function GoalCard({ goal, projects, today, onEdit, onContinue }: { goal: GoalItem; projects: ProjectItem[]; today: string; onEdit: () => void; onContinue: () => void }) {
  const { notify } = useFeedback()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<{ status: GoalStatus; token: string; title: string; description: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const period = goal.periodKind === 'NONE' ? '持续目标 · 无固定周期' : `${periodKindLabel(goal.periodKind)} · ${formatDate(goal.periodStartOn, { year: false })} — ${formatDate(goal.periodEndOn, { year: false })}`
  const changeStatus = async (status: GoalStatus, token?: string) => {
    setBusy(true)
    try {
      await todoClient.goals.setStatus(goal, status, undefined, token)
      setConfirmation(null)
      notify(`目标已设为“${statusLabels[status]}”`, 'success')
      await queryClient.invalidateQueries()
    } catch (error) {
      if (error instanceof TodoApiError && error.code === 'CONFIRMATION_REQUIRED') {
        const details = error.details ?? {}
        setConfirmation({ status, token: String(details.confirmationToken ?? ''), title: String(details.title ?? '检查关联项目'), description: String(details.description ?? `仍有关联的进行中项目。改变目标状态不会自动修改这 ${goal.activeProjectCount} 个项目。`) })
      } else notify(apiErrorMessage(error), 'error')
    } finally { setBusy(false) }
  }
  return <article className={`goal-card goal-card--${goal.status.toLowerCase()}`}>
    <header><span className={`goal-status goal-status--${goal.status.toLowerCase()}`}>{statusLabels[goal.status]}</span>{goal.category && <span className="tag tag--neutral">{goal.category.name}</span>}<button className="mini-button mini-button--danger" type="button" onClick={() => setConfirmDelete(true)}>删除</button><button className="icon-button icon-button--small" type="button" aria-label="编辑目标" onClick={onEdit}>•••</button></header>
    <h3>{goal.name}</h3>{goal.description && <p className="goal-card__description">{goal.description}</p>}
    <div className="goal-card__period"><span>◷</span>{period}{goal.periodEndOn && goal.periodEndOn < today && goal.status === 'REVIEW_REQUIRED' && <em>周期已结束</em>}</div>
    <GoalActions goal={goal} today={today} />
    <div className="goal-card__projects"><div><span>关联项目</span><strong>{projects.length}</strong></div>{projects.length > 0 && <ul>{projects.slice(0, 3).map((project) => <li key={project.id}><i className={project.status === 'COMPLETED' ? 'is-complete' : ''} />{project.name}</li>)}</ul>}</div>
    <footer>
      {goal.status === 'REVIEW_REQUIRED' && <><button className="mini-button mini-button--accent" onClick={() => changeStatus('COMPLETED')} disabled={busy}>完成目标</button><button className="mini-button" onClick={onContinue}>继续新周期</button><button className="mini-button" onClick={() => changeStatus('PAUSED')} disabled={busy}>暂停</button><button className="mini-button" onClick={() => changeStatus('ABANDONED')} disabled={busy}>放弃</button></>}
      {goal.status === 'ACTIVE' && <><button className="mini-button" onClick={() => changeStatus('PAUSED')} disabled={busy}>暂停</button><button className="mini-button" onClick={() => changeStatus('COMPLETED')} disabled={busy}>标记完成</button></>}
      {goal.status === 'PAUSED' && <button className="mini-button mini-button--accent" onClick={() => changeStatus('ACTIVE')} disabled={busy}>恢复进行</button>}
    </footer>
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} description={confirmation?.description ?? ''} confirmLabel="保持项目状态并继续" danger={confirmation?.status === 'ABANDONED'} busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => confirmation && changeStatus(confirmation.status, confirmation.token)} />
    <ConfirmDialog open={confirmDelete} title="删除目标？" description="关联任务和项目会保留，并解除与该目标的关联。" confirmLabel="删除目标" danger busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={async () => {
      setBusy(true)
      try {
        await todoClient.goals.remove(goal)
        notify('目标已删除，任务和项目已保留', 'success')
        setConfirmDelete(false)
        await queryClient.invalidateQueries()
      } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
    }} />
  </article>
}

function GoalActions({ goal, today }: { goal: GoalItem; today: string }) {
  const composer = useTaskComposer()
  const tasks = useQuery({ queryKey: ['tasks', 'goal-actions', goal.id], queryFn: () => todoClient.tasks.list({ goalId: goal.id, pageSize: Number.MAX_SAFE_INTEGER }) })
  const pending = (tasks.data ?? []).filter((task) => task.status === 'TODO').sort((a, b) => (a.plannedOn ?? '9999').localeCompare(b.plannedOn ?? '9999'))
  const recent = (tasks.data ?? []).filter((task) => task.status === 'DONE' && task.completedOn && task.completedOn >= addDays(today, -13)).sort((a, b) => (b.completedOn ?? '').localeCompare(a.completedOn ?? ''))
  return <section className="goal-actions">
    <header><h4>待推进 <span>{pending.length}</span></h4><button className="mini-button mini-button--accent" type="button" onClick={() => composer.create({ goalId: goal.id })}>＋ 添加行动</button></header>
    {tasks.isLoading ? <LoadingState /> : tasks.isError ? <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} /> : <>
      <div className="goal-actions__list">{pending.map((task) => <TaskCard key={task.id} task={task} today={today} compact />)}{!pending.length && <span className="goal-actions__empty">暂无待推进行动</span>}</div>
      <details><summary>近期完成 · 近14天 <span>{recent.length}</span></summary><div className="goal-actions__list">{recent.map((task) => <TaskCard key={task.id} task={task} today={today} compact />)}{!recent.length && <span className="goal-actions__empty">暂无完成记录</span>}</div></details>
    </>}
  </section>
}

function GoalEditor({ open, goal, categories, today, onClose }: { open: boolean; goal: GoalItem | null; categories: GoalCategory[]; today: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [busy, setBusy] = useState(false)
  return <Modal open={open} title={goal ? '编辑目标' : '新建目标'} onClose={onClose} size="large"><GoalForm key={goal?.id ?? 'new'} goal={goal} categories={categories} today={today} busy={busy} onCancel={onClose} onSubmit={async (draft) => { setBusy(true); try { if (goal) await todoClient.goals.update(goal, draft); else await todoClient.goals.create(draft); notify(goal ? '目标已保存' : '目标已创建', 'success'); await queryClient.invalidateQueries(); onClose() } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) } }} /></Modal>
}

function GoalForm({ goal, categories, today, busy, onCancel, onSubmit, periodOnly = false }: { goal: GoalItem | null; categories: GoalCategory[]; today: string; busy: boolean; onCancel: () => void; onSubmit: (draft: GoalDraft) => void; periodOnly?: boolean }) {
  const currentMonth = today.slice(0, 7)
  const [name, setName] = useState(goal?.name ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')
  const [categoryId, setCategoryId] = useState(goal?.category?.id ?? '')
  const [priority, setPriority] = useState(goal?.priority ?? '')
  const [periodKind, setPeriodKind] = useState<GoalPeriodKind>(goal?.periodKind ?? 'NONE')
  const [month, setMonth] = useState(goal?.periodKind === 'MONTH' && goal.periodStartOn ? goal.periodStartOn.slice(0, 7) : currentMonth)
  const existingQuarter = goal?.periodKind === 'QUARTER' && goal.periodStartOn ? `${goal.periodStartOn.slice(0, 4)}-Q${Math.floor((Number(goal.periodStartOn.slice(5, 7)) - 1) / 3) + 1}` : `${today.slice(0, 4)}-Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}`
  const [quarter, setQuarter] = useState(existingQuarter)
  const [year, setYear] = useState(goal?.periodKind === 'YEAR' && goal.periodStartOn ? goal.periodStartOn.slice(0, 4) : today.slice(0, 4))
  const [customStart, setCustomStart] = useState(goal?.periodKind === 'CUSTOM' ? goal.periodStartOn ?? today : today)
  const [customEnd, setCustomEnd] = useState(goal?.periodKind === 'CUSTOM' ? goal.periodEndOn ?? today : today)
  const [error, setError] = useState('')

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!periodOnly && !name.trim()) { setError('请输入目标名称'); return }
    const bounds = periodBounds(periodKind, { month, quarter, year, customStart, customEnd })
    if (bounds.startOn && bounds.endOn && bounds.startOn > bounds.endOn) { setError('周期开始日不能晚于结束日'); return }
    onSubmit({ name: name.trim() || goal?.name || '', description: description.trim() || null, categoryId: categoryId || null, priority: priority ? priority as GoalDraft['priority'] : null, periodKind, periodStartOn: bounds.startOn, periodEndOn: bounds.endOn })
  }

  return <form onSubmit={submit} className="goal-form">
    {!periodOnly && <div className="form-grid"><label className="field field--full"><span>目标名称 <b>*</b></span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError('') }} maxLength={160} /></label><label className="field field--full"><span>描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label><label className="field"><span>分类</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">未分类</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label className="field"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">未设置</option><option value="P0">P0 · 必须坚持</option><option value="P1">P1 · 优先推进</option><option value="P2">P2 · 按计划推进</option><option value="P3">P3 · 可偶尔放下</option></select></label></div>}
    <fieldset className="period-fieldset"><legend>{periodOnly ? '设置新的目标周期' : '目标周期（可选）'}</legend><div className="period-kinds">{([['NONE', '持续'], ['MONTH', '月度'], ['QUARTER', '季度'], ['YEAR', '年度'], ['CUSTOM', '自定义']] as const).map(([kind, label]) => <label className={periodKind === kind ? 'is-active' : ''} key={kind}><input type="radio" name="period-kind" checked={periodKind === kind} onChange={() => setPeriodKind(kind)} />{label}</label>)}</div>
      {periodKind === 'MONTH' && <label className="field"><span>选择自然月</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>}
      {periodKind === 'QUARTER' && <div className="quarter-picker"><label className="field"><span>年份</span><input type="number" min="2000" max="2200" value={quarter.slice(0, 4)} onChange={(event) => setQuarter(`${event.target.value}-Q${quarter.slice(-1)}`)} /></label><label className="field"><span>季度</span><select value={quarter.slice(-1)} onChange={(event) => setQuarter(`${quarter.slice(0, 4)}-Q${event.target.value}`)}><option value="1">第一季度</option><option value="2">第二季度</option><option value="3">第三季度</option><option value="4">第四季度</option></select></label></div>}
      {periodKind === 'YEAR' && <label className="field"><span>选择自然年</span><input type="number" min="2000" max="2200" value={year} onChange={(event) => setYear(event.target.value)} /></label>}
      {periodKind === 'CUSTOM' && <div className="date-range"><label className="field"><span>开始日</span><input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><span>至</span><label className="field"><span>结束日（包含当天）</span><input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button button--ghost" type="button" onClick={onCancel}>取消</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? '保存中…' : periodOnly ? '继续目标' : '保存目标'}</button></div>
  </form>
}

function ContinueGoalModal({ goal, today, onClose }: { goal: GoalItem | null; today: string; onClose: () => void }) {
  const categories = useQuery({ queryKey: ['goal-categories'], queryFn: todoClient.categories.list, enabled: Boolean(goal) })
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [busy, setBusy] = useState(false)
  return <Modal open={Boolean(goal)} title="继续目标" description="目标本身不会复制；设置新周期后回到进行中。" onClose={onClose}>{goal && <GoalForm goal={goal} categories={categories.data ?? []} today={today} busy={busy} periodOnly onCancel={onClose} onSubmit={async (draft) => { setBusy(true); try { await todoClient.goals.setStatus(goal, 'ACTIVE', draft); notify('目标已进入新的推进周期', 'success'); await queryClient.invalidateQueries(); onClose() } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) } }} />}</Modal>
}

function CategoryManager({ open, categories, onClose }: { open: boolean; categories: GoalCategory[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<GoalCategory | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const perform = async (operation: () => Promise<unknown>, message: string) => { setBusy(true); try { await operation(); notify(message, 'success'); await queryClient.invalidateQueries(); setName(''); setEditing(null) } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) } }
  return <Modal open={open} title="目标分类" onClose={onClose}><form className="category-add" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void perform(() => todoClient.categories.create(name.trim()), '分类已创建') }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="新分类名称" /><button className="button button--secondary" type="submit" disabled={busy || !name.trim()}>添加</button></form><div className="category-list">{categories.map((category) => editing?.id === category.id ? <form key={category.id} onSubmit={(event) => { event.preventDefault(); if (editName.trim()) void perform(() => todoClient.categories.rename(category, editName.trim()), '分类已重命名') }}><input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} /><button className="mini-button" type="submit">保存</button><button className="mini-button" type="button" onClick={() => setEditing(null)}>取消</button></form> : <div key={category.id}><span>{category.name}</span><button className="mini-button" type="button" onClick={() => { setEditing(category); setEditName(category.name) }}>重命名</button><button className="mini-button mini-button--danger" type="button" onClick={() => void perform(() => todoClient.categories.remove(category.id), '分类已删除')}>删除</button></div>)}</div>{!categories.length && <EmptyState icon="◎" title="还没有分类" />}</Modal>
}

function periodKindLabel(kind: GoalPeriodKind): string { return kind === 'MONTH' ? '月度' : kind === 'QUARTER' ? '季度' : kind === 'YEAR' ? '年度' : kind === 'CUSTOM' ? '自定义' : '持续' }

function periodBounds(kind: GoalPeriodKind, value: { month: string; quarter: string; year: string; customStart: string; customEnd: string }): { startOn: string | null; endOn: string | null } {
  if (kind === 'NONE') return { startOn: null, endOn: null }
  if (kind === 'MONTH') {
    const [year, month] = value.month.split('-').map(Number)
    const end = new Date(year!, month!, 0, 12)
    return { startOn: `${value.month}-01`, endOn: `${year}-${String(month).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}` }
  }
  if (kind === 'QUARTER') {
    const year = value.quarter.slice(0, 4)
    const q = Number(value.quarter.slice(-1))
    const startMonth = (q - 1) * 3 + 1
    const endMonth = startMonth + 2
    const end = new Date(Number(year), endMonth, 0, 12)
    return { startOn: `${year}-${String(startMonth).padStart(2, '0')}-01`, endOn: `${year}-${String(endMonth).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}` }
  }
  if (kind === 'YEAR') return { startOn: `${value.year}-01-01`, endOn: `${value.year}-12-31` }
  return { startOn: value.customStart, endOn: value.customEnd }
}
