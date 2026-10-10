import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GoalItem, ProjectItem, TaskItem } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { ConfirmDialog, Modal } from '../components/Modal'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'

export function ProjectsPage({ today }: { today: string }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'COMPLETED'>('ACTIVE')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<ProjectItem | 'NEW' | null>(null)
  const filtered = useMemo(() => (projects.data ?? []).filter((project) => {
    return (statusFilter === 'ALL' || project.status === statusFilter) && (!search.trim() || project.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  }), [projects.data, search, statusFilter])

  useEffect(() => {
    if (!selectedId && filtered[0]) setSelectedId(filtered[0].id)
    if (selectedId && !filtered.some((project) => project.id === selectedId)) setSelectedId(filtered[0]?.id ?? null)
  }, [filtered, selectedId])

  const detail = useQuery({ queryKey: ['projects', selectedId], queryFn: () => todoClient.projects.detail(selectedId!), enabled: Boolean(selectedId) })

  return (
    <div className="page page--wide">
      <PageHeader title="项目" actions={<button className="button button--primary" type="button" onClick={() => setEditor('NEW')}>＋ 新建项目</button>} />
      <div className="master-detail">
        <aside className="master-list">
          <div className="master-list__tools">
            <label className="search-box search-box--small"><span>⌕</span><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <div className="segmented segmented--small">{([['ACTIVE', '进行中'], ['COMPLETED', '已完成'], ['ALL', '全部']] as const).map(([value, label]) => <button type="button" key={value} className={statusFilter === value ? 'is-active' : ''} onClick={() => setStatusFilter(value)}>{label}</button>)}</div>
          </div>
          {projects.isLoading ? <LoadingState /> : projects.isError ? <ErrorState error={projects.error} onRetry={() => projects.refetch()} /> : filtered.length ? <div className="master-list__items">{filtered.map((project) => (
            <button type="button" className={selectedId === project.id ? 'project-list-card is-active' : 'project-list-card'} key={project.id} onClick={() => setSelectedId(project.id)}>
              <span className="project-list-card__icon">{project.status === 'COMPLETED' ? '✓' : '□'}</span>
              <span><strong>{project.name}</strong><small>{project.goal?.name ?? '独立项目'}</small></span>
              <em>{project.openTaskCount}</em>
            </button>
          ))}</div> : <EmptyState icon="□" title="没有项目" />}
        </aside>
        <section className="detail-surface">
          {!selectedId ? <EmptyState icon="□" title="选择一个项目" /> : detail.isLoading ? <LoadingState label="正在读取项目…" /> : detail.isError || !detail.data ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> : <ProjectDetail project={detail.data} today={today} onEdit={() => setEditor(detail.data)} onDeleted={() => setSelectedId(null)} />}
        </section>
      </div>
      <ProjectEditor open={Boolean(editor)} project={editor === 'NEW' ? null : editor} onClose={() => setEditor(null)} onCreated={(id) => { setEditor(null); if (id) setSelectedId(id) }} />
    </div>
  )
}

function ProjectDetail({ project, today, onEdit, onDeleted }: { project: ProjectItem; today: string; onEdit: () => void; onDeleted: () => void }) {
  const composer = useTaskComposer()
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tasks = project.tasks ?? []
  const roots = tasks.filter((task) => !task.parent)
  const groups = [
    { key: 'parents', title: '父工作', tasks: roots.filter((task) => task.status === 'TODO' && task.hasChildren) },
    { key: 'unassigned', title: '待分配', tasks: roots.filter((task) => task.status === 'TODO' && !task.hasChildren && !task.plannedOn) },
    { key: 'scheduled', title: '已排期', tasks: roots.filter((task) => task.status === 'TODO' && !task.hasChildren && task.plannedOn) },
    { key: 'done', title: '已完成', tasks: roots.filter((task) => task.status === 'DONE') },
    { key: 'cancelled', title: '已取消', tasks: roots.filter((task) => task.status === 'CANCELLED') }
  ]

  const setStatus = async () => {
    setBusy(true)
    try {
      await todoClient.projects.setStatus(project, project.status === 'ACTIVE' ? 'COMPLETED' : 'ACTIVE')
      notify(project.status === 'ACTIVE' ? '项目已完成，历史任务继续保留' : '项目已恢复为进行中', 'success')
      await queryClient.invalidateQueries()
    } catch (error) {
      notify(apiErrorMessage(error), 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="project-detail">
      <header className="detail-hero">
        <div className="detail-hero__icon">{project.status === 'COMPLETED' ? '✓' : '□'}</div>
        <div className="detail-hero__copy"><span className="eyebrow">{project.status === 'ACTIVE' ? '进行中项目' : '已完成项目'}</span><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}{project.goal && <span className="goal-link">◎ 支撑目标：{project.goal.name}</span>}</div>
        <div className="detail-hero__actions"><button className="button button--ghost" type="button" onClick={onEdit}>编辑</button><button className="button button--ghost" type="button" onClick={() => setConfirmDelete(true)}>删除</button><button className={project.status === 'ACTIVE' ? 'button button--secondary' : 'button button--primary'} type="button" disabled={busy} onClick={setStatus}>{busy ? '处理中…' : project.status === 'ACTIVE' ? '完成项目' : '恢复项目'}</button></div>
      </header>
      <div className="metric-row"><div><strong>{project.openTaskCount}</strong><span>待办任务</span></div><div><strong>{project.executableTaskCount}</strong><span>可执行下一步</span></div><div><strong>{project.activeSeriesCount}</strong><span>启用重复系列</span></div></div>
      {project.status === 'ACTIVE' && !project.hasNextAction && <div className="next-action-alert"><span>→</span><div><strong>暂无下一步任务</strong></div><button className="button button--secondary" type="button" onClick={() => composer.create({ projectId: project.id })}>补充下一步</button></div>}
      {project.status === 'ACTIVE' && project.hasNextAction && <div className="detail-toolbar"><h3>完整任务树</h3><button className="button button--secondary" type="button" onClick={() => composer.create({ projectId: project.id })}>＋ 添加任务</button></div>}
      {groups.map((group) => group.tasks.length > 0 && <details className="project-task-group" open={group.key === 'parents' || group.key === 'unassigned' || group.key === 'scheduled'} key={group.key}><summary>{group.title}<em>{group.tasks.length}</em></summary><div className="task-tree-list">{group.tasks.map((task) => <ProjectTaskTree task={task} allTasks={tasks} today={today} key={task.id} />)}</div></details>)}
      {!tasks.length && <EmptyState icon="→" title="项目还没有行动" action={project.status === 'ACTIVE' ? <button className="button button--primary" type="button" onClick={() => composer.create({ projectId: project.id })}>创建第一项任务</button> : undefined} />}
      <ConfirmDialog open={confirmDelete} title="删除项目？" description="项目中的任务会保留并转为无项目，重复系列也会解除项目关联。" confirmLabel="删除项目" danger busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={async () => {
        setBusy(true)
        try {
          await todoClient.projects.remove(project)
          notify('项目已删除，原任务已转为无项目', 'success')
          setConfirmDelete(false)
          onDeleted()
          await queryClient.invalidateQueries()
        } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
      }} />
    </div>
  )
}

function ProjectTaskTree({ task, allTasks, today }: { task: TaskItem; allTasks: TaskItem[]; today: string }) {
  const composer = useTaskComposer()
  const children = allTasks.filter((child) => child.parent?.id === task.id)
  return <div className={children.length ? 'task-tree-node has-children' : 'task-tree-node'}><TaskCard task={{ ...task, children }} today={today} compact />{children.length > 0 && <div className="task-tree-node__children">{children.map((child) => <TaskCard task={child} today={today} compact key={child.id} />)}{task.status === 'TODO' && <button className="add-child-row" type="button" onClick={() => composer.child(task)}>＋ 添加下一条子工作</button>}</div>}</div>
}

function ProjectEditor({ open, project, onClose, onCreated }: { open: boolean; project: ProjectItem | null; onClose: () => void; onCreated: (id?: string) => void }) {
  const goals = useQuery({ queryKey: ['goals', 'project-picker'], queryFn: () => todoClient.goals.list({ status: 'ALL' }), enabled: open })
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [busy, setBusy] = useState(false)
  return <Modal open={open} title={project ? '编辑项目' : '新建项目'} onClose={onClose}>
    <ProjectForm key={project?.id ?? 'new'} project={project} goals={goals.data ?? []} busy={busy} onCancel={onClose} onSubmit={async (draft) => {
      setBusy(true)
      try {
        const result = project ? await todoClient.projects.update(project, draft) : await todoClient.projects.create(draft)
        const record = result as { value?: { id?: string }; id?: string }
        notify(project ? '项目已保存' : '项目已创建', 'success')
        await queryClient.invalidateQueries()
        onCreated(record.value?.id ?? record.id)
      } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
    }} />
  </Modal>
}

function ProjectForm({ project, goals, busy, onCancel, onSubmit }: { project: ProjectItem | null; goals: GoalItem[]; busy: boolean; onCancel: () => void; onSubmit: (draft: { name: string; description: string | null; goalId: string | null }) => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [goalId, setGoalId] = useState(project?.goal?.id ?? '')
  const [error, setError] = useState('')
  return <form onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError('请输入项目名称'); return } onSubmit({ name: name.trim(), description: description.trim() || null, goalId: goalId || null }) }}>
    <div className="form-grid"><label className="field field--full"><span>项目名称 <b>*</b></span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError('') }} />{error && <small className="field-error">{error}</small>}</label><label className="field field--full"><span>项目描述</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label className="field field--full"><span>所属目标</span><select value={goalId} onChange={(event) => setGoalId(event.target.value)}><option value="">不关联目标</option>{goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.priority ? `${goal.priority} · ` : ''}{goal.name}</option>)}</select></label></div>
    <div className="modal-actions"><button className="button button--ghost" type="button" onClick={onCancel}>取消</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存项目'}</button></div>
  </form>
}
