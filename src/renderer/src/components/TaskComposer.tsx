import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TaskDraft, TaskItem } from '../../domain'
import { TodoApiError, apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from './Feedback'
import { ConfirmDialog, Modal } from './Modal'
import { ErrorState, LoadingState } from './States'
import { formatDate } from '../utils/date'

type ComposerRequest =
  | { kind: 'create'; defaultTitle?: string; defaultPlannedOn?: string | null; defaultProjectId?: string | null; defaultGoalId?: string | null }
  | { kind: 'edit'; task: TaskItem }
  | { kind: 'child'; parent: TaskItem }
  | { kind: 'next'; source: TaskItem }

interface TaskFormSubmission extends TaskDraft {
  newParentTitle?: string | null
}

interface ComposerContextValue {
  followup: (parent: TaskItem) => void
  create: (defaults?: { title?: string; plannedOn?: string | null; projectId?: string | null; goalId?: string | null }) => void
  edit: (task: TaskItem) => void
  child: (parent: TaskItem) => void
  nextStep: (source: TaskItem) => void
}

const TaskComposerContext = createContext<ComposerContextValue | null>(null)

export function useTaskComposer(): ComposerContextValue {
  const context = useContext(TaskComposerContext)
  if (!context) throw new Error('useTaskComposer must be used inside TaskComposerProvider')
  return context
}

export function TaskComposerProvider({ children, today }: { children: ReactNode; today: string }) {
  const [parentFollowup, setParentFollowup] = useState<TaskItem | null>(null)
  const [request, setRequest] = useState<ComposerRequest | null>(null)
  const value = useMemo<ComposerContextValue>(() => ({
    followup: setParentFollowup,
    create: (defaults) => setRequest({ kind: 'create', defaultTitle: defaults?.title, defaultPlannedOn: defaults?.plannedOn, defaultProjectId: defaults?.projectId, defaultGoalId: defaults?.goalId }),
    edit: (task) => setRequest({ kind: 'edit', task }),
    child: (parent) => setRequest({ kind: 'child', parent }),
    nextStep: (source) => setRequest({ kind: 'next', source })
  }), [])

  return (
    <TaskComposerContext.Provider value={value}>
      {children}
      <ParentFollowup parentFollowup={parentFollowup} setParentFollowup={setParentFollowup} />
      <TaskDrawer
        request={request}
        today={today}
        onClose={() => setRequest(null)}
        onReplace={setRequest}
      />
    </TaskComposerContext.Provider>
  )
}

function ParentFollowup({ parentFollowup, setParentFollowup }: { parentFollowup: TaskItem | null; setParentFollowup: (parent: TaskItem | null) => void }) {
  const [busy, setBusy] = useState(false)
  const composer = useTaskComposer()
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const refresh = () => queryClient.invalidateQueries()
  return (
      <Modal
        open={Boolean(parentFollowup)}
        title="父工作还需要继续吗？"
        description={parentFollowup ? `“${parentFollowup.title}”已经没有其他待办子工作。` : undefined}
        onClose={() => setParentFollowup(null)}
        size="small"
      >
        <div className="modal-actions modal-actions--stacked">
          <button type="button" className="button button--ghost" onClick={() => setParentFollowup(null)} disabled={busy}>稍后决定</button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={async () => {
            if (!parentFollowup) return
            setBusy(true)
            try {
              const parent = await todoClient.tasks.detail(parentFollowup.id)
              if (parent.status !== 'TODO') {
                notify('父工作状态已经变化', 'info')
              } else {
                setParentFollowup(null)
                composer.child(parent)
              }
            } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
          }}>继续添加子工作</button>
          <button type="button" className="button button--primary" disabled={busy} onClick={async () => {
            if (!parentFollowup) return
            setBusy(true)
            try {
              const parent = await todoClient.tasks.detail(parentFollowup.id)
              if (parent.status !== 'TODO') {
                notify('父工作状态已经变化', 'info')
              } else if (parent.pendingChildCount > 0) {
                notify('父工作已有新的待办子工作，请先处理', 'info')
              } else {
                await todoClient.tasks.setStatus(parent, 'DONE')
                notify('父工作已完成', 'success')
              }
              setParentFollowup(null)
              await refresh()
            } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
          }}>{busy ? '处理中…' : '完成父工作'}</button>
        </div>
      </Modal>
  )
}

function TaskDrawer({ request, today, onClose, onReplace }: {
  request: ComposerRequest | null
  today: string
  onClose: () => void
  onReplace: (request: ComposerRequest) => void
}) {
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list, enabled: Boolean(request) })
  const goals = useQuery({ queryKey: ['goals', 'task-picker'], queryFn: () => todoClient.goals.list(), enabled: Boolean(request), retry: false })
  const parents = useQuery({
    queryKey: ['tasks', 'parent-candidates'],
    queryFn: () => todoClient.tasks.list({ status: 'ALL', pageSize: 500 }),
    enabled: Boolean(request?.kind === 'create' || request?.kind === 'edit')
  })
  const taskForEdit = request?.kind === 'edit' ? request.task : null
  const detail = useQuery({
    queryKey: ['task-detail', taskForEdit?.id],
    queryFn: () => todoClient.tasks.detail(taskForEdit!.id),
    enabled: Boolean(taskForEdit)
  })
  const task = detail.data ?? taskForEdit
  const [busy, setBusy] = useState(false)
  const [confirmMove, setConfirmMove] = useState<{
    task: TaskItem
    projectId: string | null
    token: string
    title: string
    description: string
  } | null>(null)
  const [confirmAttach, setConfirmAttach] = useState<{
    task: TaskItem
    parent: TaskItem
    token: string
  } | null>(null)

  if (!request) return null

  const title = request.kind === 'edit'
    ? '任务详情'
    : request.kind === 'child'
      ? '添加子工作'
      : request.kind === 'next'
        ? '创建下一步任务'
        : '新建任务'
  return (
    <>
      <Modal open title={title} size="large" onClose={onClose}>
        {request.kind === 'edit' && detail.isLoading ? <LoadingState label="正在读取任务详情…" /> :
          request.kind === 'edit' && detail.isError ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> :
            <TaskForm
              key={`${request.kind}-${request.kind === 'edit' ? request.task.id : request.kind === 'child' ? request.parent.id : request.kind === 'next' ? request.source.id : 'new'}`}
              request={request}
              task={task}
              today={today}
              projects={projects.data ?? []}
              goals={goals.data ?? []}
              parentCandidates={(parents.data ?? []).filter((candidate) =>
                candidate.id !== task?.id &&
                !candidate.parent &&
                !candidate.recurrenceSeriesId &&
                (candidate.id === task?.parent?.id || (task?.status ?? 'TODO') !== 'TODO' || candidate.status === 'TODO')
              )}
              busy={busy}
              onCancel={onClose}
              onCreateChild={task ? () => onReplace({ kind: 'child', parent: task }) : undefined}
              onSubmit={async (draft) => {
                setBusy(true)
                try {
                  if (request.kind === 'create') {
                    const created = await todoClient.tasks.create({ ...draft, parentTaskId: draft.newParentTitle ? null : draft.parentTaskId })
                    if (draft.newParentTitle) await todoClient.tasks.createParentAndAttach(created, draft.newParentTitle)
                  } else if (request.kind === 'child') {
                    await todoClient.tasks.addChild(request.parent, draft)
                  } else if (request.kind === 'next') {
                    await todoClient.tasks.createNextStep(request.source, draft)
                  } else if (task) {
                    let current = task
                    if ((draft.goalId ?? null) !== (task.goal?.id ?? null) || draft.title !== task.title || (draft.notes ?? null) !== task.notes || Boolean(draft.important) !== task.important || Boolean(draft.urgent) !== task.urgent) {
                      current = await todoClient.tasks.updateContent(current, draft)
                    }
                    if ((draft.plannedOn ?? null) !== task.plannedOn || (draft.plannedStartOn ?? null) !== (task.plannedStartOn ?? null)) {
                      current = await todoClient.tasks.schedule(current, draft.plannedOn ?? null, draft.plannedStartOn ?? null)
                    }
                    if (draft.newParentTitle) {
                      await todoClient.tasks.createParentAndAttach(current, draft.newParentTitle)
                      notify(`已新建父工作“${draft.newParentTitle}”并完成挂接`, 'success')
                      await queryClient.invalidateQueries()
                      onClose()
                      return
                    }
                    const targetParentId = draft.parentTaskId ?? null
                    if (targetParentId !== (task.parent?.id ?? null)) {
                      if (targetParentId === null) {
                        current = await todoClient.tasks.detachParent(current)
                      } else {
                        const parent = (parents.data ?? []).find((candidate) => candidate.id === targetParentId)
                        if (!parent) throw new Error('所选父工作不存在')
                        try {
                          current = await todoClient.tasks.attachParent(current, parent.id)
                        } catch (error) {
                          if (error instanceof TodoApiError && error.code === 'CONFIRMATION_REQUIRED') {
                            setConfirmAttach({ task: current, parent, token: String(error.details?.confirmationToken ?? '') })
                            return
                          }
                          throw error
                        }
                      }
                    }
                    const targetProject = draft.projectId ?? null
                    if (targetParentId === null && targetProject !== (current.project?.id ?? null)) {
                      try {
                        current = await todoClient.tasks.moveGroupProject(current, targetProject)
                      } catch (error) {
                        if (error instanceof TodoApiError && error.code === 'CONFIRMATION_REQUIRED') {
                          const details = error.details ?? {}
                          setConfirmMove({
                            task: current,
                            projectId: targetProject,
                            token: String(details.confirmationToken ?? ''),
                            title: String(details.title ?? '确认整组迁移？'),
                            description: String(details.description ?? '父工作与全部子工作必须属于同一项目，将一起迁移。')
                          })
                          return
                        }
                        throw error
                      }
                    }
                  }
                  notify(request.kind === 'edit' ? '任务已保存' : '任务已创建', 'success')
                  await queryClient.invalidateQueries()
                  onClose()
                } catch (error) {
                  notify(apiErrorMessage(error), 'error')
                } finally {
                  setBusy(false)
                }
              }}
            />}
      </Modal>
      <ConfirmDialog
        open={Boolean(confirmMove)}
        title={confirmMove?.title ?? ''}
        description={confirmMove?.description ?? ''}
        confirmLabel="迁移整组任务"
        busy={busy}
        onCancel={() => setConfirmMove(null)}
        onConfirm={async () => {
          if (!confirmMove) return
          setBusy(true)
          try {
            await todoClient.tasks.moveGroupProject(confirmMove.task, confirmMove.projectId, confirmMove.token)
            notify('父工作与子工作已一起迁移', 'success')
            setConfirmMove(null)
            await queryClient.invalidateQueries()
            onClose()
          } catch (error) {
            notify(apiErrorMessage(error), 'error')
          } finally {
            setBusy(false)
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(confirmAttach)}
        title="确认迁移并挂接？"
        description={confirmAttach
          ? `“${confirmAttach.task.title}”当前属于${projectLabel(confirmAttach.task)}；挂接到“${confirmAttach.parent.title}”后将迁入${projectLabel(confirmAttach.parent)}。日期、状态、历史和四象限属性保持不变。`
          : ''}
        confirmLabel="迁移并挂接"
        busy={busy}
        onCancel={() => setConfirmAttach(null)}
        onConfirm={async () => {
          if (!confirmAttach) return
          setBusy(true)
          try {
            await todoClient.tasks.attachParent(confirmAttach.task, confirmAttach.parent.id, confirmAttach.token)
            notify(`已迁入${projectLabel(confirmAttach.parent)}并挂接`, 'success')
            setConfirmAttach(null)
            await queryClient.invalidateQueries()
            onClose()
          } catch (error) {
            notify(apiErrorMessage(error), 'error')
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}

function TaskForm({ request, task, today, projects, goals, parentCandidates, busy, onCancel, onCreateChild, onSubmit }: {
  request: ComposerRequest
  task: TaskItem | null
  today: string
  projects: Array<{ id: string; name: string; status: string }>
  goals: Array<{ id: string; name: string }>
  parentCandidates: TaskItem[]
  busy: boolean
  onCancel: () => void
  onCreateChild?: () => void
  onSubmit: (draft: TaskFormSubmission) => void
}) {
  const isEdit = request.kind === 'edit'
  const inheritedProjectId = request.kind === 'child'
    ? request.parent.project?.id ?? null
    : request.kind === 'next'
      ? request.source.project?.id ?? null
      : undefined
  const initialDate = isEdit
    ? task?.plannedOn ?? ''
    : request.kind === 'create'
      ? request.defaultPlannedOn ?? ''
      : ''
  const initialProject = isEdit
    ? task?.project?.id ?? ''
    : request.kind === 'create'
      ? request.defaultProjectId ?? ''
      : inheritedProjectId ?? ''
  const [title, setTitle] = useState(isEdit ? task?.title ?? '' : request.kind === 'create' ? request.defaultTitle ?? '' : '')
  const [notes, setNotes] = useState(isEdit ? task?.notes ?? '' : '')
  const [plannedOn, setPlannedOn] = useState(initialDate)
  const [plannedStartOn, setPlannedStartOn] = useState(isEdit ? task?.plannedStartOn ?? '' : '')
  const [projectId, setProjectId] = useState(initialProject)
  const [goalId, setGoalId] = useState(isEdit ? task?.goal?.id ?? '' : request.kind === 'create' ? request.defaultGoalId ?? '' : request.kind === 'next' ? request.source.goal?.id ?? '' : '')
  const [parentId, setParentId] = useState(request.kind === 'create' ? '' : request.kind === 'child' ? request.parent.id : isEdit ? task?.parent?.id ?? '' : '')
  const [important, setImportant] = useState(isEdit ? Boolean(task?.important) : false)
  const [urgent, setUrgent] = useState(isEdit ? Boolean(task?.urgent) : false)
  const [titleError, setTitleError] = useState('')
  const [newParentOpen, setNewParentOpen] = useState(false)
  const [newParentTitle, setNewParentTitle] = useState('')
  const invalidDateRange = Boolean(plannedStartOn && plannedOn && plannedStartOn > plannedOn)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (invalidDateRange) return
    if (!title.trim()) {
      setTitleError('请写下一条清晰的行动或事项')
      return
    }
    onSubmit({
      title: title.trim(),
      notes: notes.trim() || null,
      plannedOn: plannedOn || null,
      plannedStartOn: plannedStartOn || null,
      projectId: projectId || null,
      goalId: goalId || null,
      parentTaskId: parentId || null,
      newParentTitle: newParentTitle.trim() || null,
      important,
      urgent
    })
  }

  return (
    <form className="task-form" onSubmit={submit}>
      <div className="form-grid form-grid--task">
        <label className="field field--full">
          <span>任务标题 <b>*</b></span>
          <input value={title} onChange={(event) => { setTitle(event.target.value); setTitleError('') }} autoFocus maxLength={160} />
          {titleError && <small className="field-error">{titleError}</small>}
        </label>
        {(request.kind === 'create' || (isEdit && task && !task.hasChildren && !task.recurrenceSeriesId)) && (
          <div className="field field--full parent-link-field">
            <span>父工作</span>
            <div className="parent-link-row">
              <select aria-label="父工作" value={newParentOpen ? '' : parentId} disabled={newParentOpen} onChange={(event) => {
                const next = event.target.value
                setParentId(next)
                setNewParentTitle('')
                const parent = parentCandidates.find((item) => item.id === next)
                if (parent) setProjectId(parent.project?.id ?? '')
              }}>
                <option value="">挂接父工作</option>
                {parentCandidates.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
              </select>
              {parentId && !newParentOpen && <button className="mini-button" type="button" onClick={() => setParentId('')}>解除</button>}
              <button className="mini-button mini-button--accent" type="button" onClick={() => {
                setNewParentOpen((open) => !open)
                setNewParentTitle('')
              }}>{newParentOpen ? '返回挂接' : '＋ 新建'}</button>
            </div>
            {newParentOpen && <input aria-label="新建父工作" autoFocus value={newParentTitle} onChange={(event) => setNewParentTitle(event.target.value)} maxLength={200} placeholder="输入父工作名称，回车创建并挂接" />}
          </div>
        )}
        {request.kind === 'child' && <div className="field field--full parent-link-field"><span>父工作</span><strong>{request.parent.title}</strong></div>}
        <label className="field field--full">
          <span>备注</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} maxLength={4000} />
        </label>
        <label className="field field--full"><span>支撑目标</span><select value={goalId} onChange={(event) => setGoalId(event.target.value)}><option value="">不关联目标</option>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select></label>
        <label className="field">
          <span>计划开始时间</span>
          <input aria-label="计划开始时间" aria-invalid={invalidDateRange} aria-describedby={invalidDateRange ? 'task-date-range-error' : undefined} type="date" value={plannedStartOn} onChange={(event) => setPlannedStartOn(event.target.value)} />
          <small>可不填写；只有开始时间时，任务仍在待分配中。</small>
        </label>
        <label className="field">
          <span>计划完成时间</span>
          <input aria-label="计划完成时间" aria-invalid={invalidDateRange} aria-describedby={invalidDateRange ? 'task-date-range-error' : undefined} type="date" value={plannedOn} onChange={(event) => setPlannedOn(event.target.value)} />
          {plannedOn && <small>{formatDate(plannedOn, { weekday: true })}</small>}
          {invalidDateRange && <small id="task-date-range-error" className="field-error" role="alert">计划开始时间不能晚于计划完成时间</small>}
        </label>
        <label className="field">
          <span>所属项目</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={request.kind === 'child' || request.kind === 'next' || Boolean(parentId) || Boolean(newParentTitle.trim())}>
            <option value="">不属于项目</option>
            {projects.filter((project) => project.status === 'ACTIVE' || project.id === projectId).map((project) => (
              <option value={project.id} key={project.id}>{project.name}{project.status === 'COMPLETED' ? '（已完成）' : ''}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="quadrant-choice">
        <legend>四象限属性</legend>
        <label className={important ? 'toggle-card is-active' : 'toggle-card'}>
          <input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} />
          <span><b>重要</b></span>
        </label>
        <label className={urgent ? 'toggle-card is-active is-urgent' : 'toggle-card'}>
          <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
          <span><b>紧急</b></span>
        </label>
      </fieldset>

      {isEdit && task?.hasChildren && (
        <section className="child-summary-panel">
          <header><strong>子工作</strong><span>{task.pendingChildCount} 项待办</span>{task.status === 'TODO' && onCreateChild && <button className="mini-button mini-button--accent" type="button" onClick={onCreateChild}>＋ 添加</button>}</header>
          {task.children && task.children.length > 0 && <ul className="child-summary">{task.children.map((child) => <li key={child.id}><span className={`status-dot status-dot--${child.status.toLowerCase()}`} />{child.title}<small>{child.plannedOn ?? '未排期'}</small></li>)}</ul>}
        </section>
      )}

      <div className="modal-actions modal-actions--spread">
        <button type="button" className="button button--ghost" onClick={onCancel}>取消</button>
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={busy || invalidDateRange}>{busy ? '正在保存…' : isEdit ? '保存修改' : '创建任务'}</button>
        </div>
      </div>
    </form>
  )
}

function projectLabel(task: TaskItem): string {
  return task.project ? `项目“${task.project.name}”` : '“无项目”'
}
