import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TaskItem } from '../../domain'
import { TodoApiError, apiErrorMessage, todoClient } from '../../client'
import { relativeDateLabel } from '../utils/date'
import { ConfirmDialog } from './Modal'
import { useFeedback } from './Feedback'
import { useTaskComposer } from './TaskComposer'

export interface TaskCardViewProps {
  task: TaskItem
  today: string
  compact?: boolean
  todayRow?: boolean
  selected?: boolean
  busy?: boolean
  hideRestoreAction?: boolean
  onOpen?: () => void
  onToggleDone?: () => void
  onCancel?: () => void
  onRestore?: () => void
  onSchedule?: (plannedOn: string | null) => void
  onNextStep?: () => void
}

export function QuadrantPips({ important, urgent, activeOnly = false }: { important: boolean; urgent: boolean; activeOnly?: boolean }) {
  if (activeOnly && !important && !urgent) return null
  const label = important && urgent
    ? '重要且紧急'
    : important
      ? '重要不紧急'
      : urgent
        ? '不重要但紧急'
        : '不重要不紧急'
  return (
    <span className="quadrant-pips" aria-label={label} title={label}>
      {(!activeOnly || important) && <i className={important ? 'is-on is-important' : ''}>重</i>}
      {(!activeOnly || urgent) && <i className={urgent ? 'is-on is-urgent' : ''}>急</i>}
    </span>
  )
}

export function TaskCardView({
  task,
  today,
  compact,
  todayRow,
  selected,
  busy,
  hideRestoreAction,
  onOpen,
  onToggleDone,
  onCancel,
  onRestore,
  onSchedule,
  onNextStep
}: TaskCardViewProps) {
  const [scheduling, setScheduling] = useState(false)
  const context = [task.project?.name, task.parent ? `↳ ${task.parent.name}` : null, task.goal ? `◎ ${task.goal.name}` : null].filter(Boolean).join(' · ')
  const isDone = task.status === 'DONE'
  const isCancelled = task.status === 'CANCELLED'
  const hasQuadrant = task.important || task.urgent

  return (
    <article className={`task-card${compact ? ' task-card--compact' : ''}${todayRow ? ' task-card--today-row' : ''}${todayRow && hasQuadrant ? ' has-quadrant' : ''}${selected ? ' is-selected' : ''}${isDone ? ' is-done' : ''}${isCancelled ? ' is-cancelled' : ''}`}>
      <button
        type="button"
        className="task-check"
        aria-label={isDone ? '恢复为待办' : task.hasChildren ? '父工作状态' : '标记完成'}
        title={task.hasChildren ? '父工作需手动完成' : undefined}
        onClick={isDone || isCancelled ? onRestore : onToggleDone}
        disabled={busy}
      >
        {isDone ? '✓' : isCancelled ? '×' : task.hasChildren ? '−' : ''}
      </button>
      {todayRow && hasQuadrant && <QuadrantPips important={task.important} urgent={task.urgent} activeOnly />}
      <button type="button" className="task-card__main" onClick={onOpen}>
        <span className="task-card__title-row">
          <strong>{task.title}</strong>
          {task.hasChildren && <span className="tag tag--neutral">父工作 · {task.pendingChildCount} 项待办</span>}
          {task.recurrenceSeriesId && <span className="tag tag--violet" title="来自重复系列">↻ 重复</span>}
        </span>
        {context && <span className="task-card__context">{context}</span>}
        {!todayRow && (
          <span className="task-card__meta">
            <span className={task.isOverdue ? 'date-label is-overdue' : 'date-label'}>
              {task.isOverdue && '已逾期 · '}{relativeDateLabel(task.plannedOn, today)}
            </span>
            <QuadrantPips important={task.important} urgent={task.urgent} />
            {isDone && task.completedOn && <span className="tag tag--success">{task.completedOn} 完成</span>}
            {isCancelled && <span className="tag tag--neutral">已取消</span>}
          </span>
        )}
      </button>
      <div className="task-card__actions">
        {task.status === 'TODO' && onSchedule && (
          scheduling
            ? <InlineDatePicker value={task.plannedOn} onSelect={(value) => { onSchedule(value); setScheduling(false) }} onClose={() => setScheduling(false)} />
            : <button className="mini-button" type="button" onClick={() => setScheduling(true)} disabled={busy}>日期</button>
        )}
        {task.status === 'TODO' && task.plannedOn && !task.hasChildren && onSchedule && <button className="mini-button" type="button" onClick={() => onSchedule(null)} disabled={busy}>待分配</button>}
        {task.status === 'TODO' && onCancel && <button className="mini-button" type="button" onClick={onCancel} disabled={busy}>取消</button>}
        {task.status === 'DONE' && onNextStep && <button className="mini-button mini-button--accent" type="button" onClick={onNextStep}>创建下一步</button>}
        {!hideRestoreAction && (isDone || isCancelled) && onRestore && <button className="mini-button" type="button" onClick={onRestore} disabled={busy}>恢复待办</button>}
      </div>
    </article>
  )
}

function InlineDatePicker({ value, onSelect, onClose }: {
  value: string | null
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    try { input?.showPicker() } catch { /* The visible date input remains usable. */ }
  }, [])

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!editorRef.current?.contains(event.target as Node)) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', closeOnOutsideClick, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  return (
    <div className="inline-date-editor" ref={editorRef}>
      <input
        ref={inputRef}
        aria-label="选择计划完成日"
        type="date"
        defaultValue={value ?? ''}
        onChange={(event) => {
          if (event.currentTarget.value) onSelect(event.currentTarget.value)
        }}
      />
    </div>
  )
}

export function TaskCard({ task, today, compact, todayRow, hideRestoreAction, onChanged }: {
  task: TaskItem
  today: string
  compact?: boolean
  todayRow?: boolean
  hideRestoreAction?: boolean
  onChanged?: () => void
}) {
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const composer = useTaskComposer()
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    status: TaskItem['status']
    token: string
    title: string
    description: string
  } | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries()
    onChanged?.()
  }

  const changeStatus = async (status: TaskItem['status'], token?: string) => {
    setBusy(true)
    try {
      const updated = await todoClient.tasks.setStatus(task, status, token)
      setConfirmation(null)
      notify(status === 'DONE' ? '任务已完成' : status === 'CANCELLED' ? '任务已取消' : '任务已恢复为待办', 'success')
      if (status === 'DONE' && updated.parent) {
        try {
          const parent = await todoClient.tasks.detail(updated.parent.id)
          if (parent.status === 'TODO' && parent.pendingChildCount === 0) composer.followup(parent)
        } catch {
          // Completing the child succeeded; a follow-up prompt is best-effort.
        }
      }
      await refresh()
    } catch (error) {
      if (error instanceof TodoApiError && error.code === 'CONFIRMATION_REQUIRED') {
        const details = error.details ?? {}
        setConfirmation({
          status,
          token: String(details.confirmationToken ?? ''),
          title: String(details.title ?? (status === 'DONE' ? '确认完成父工作？' : '确认取消父工作？')),
          description: String(details.description ?? `仍有 ${task.pendingChildCount} 个待办子工作。本次操作不会改变这些子工作。`)
        })
      } else {
        notify(apiErrorMessage(error), 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const schedule = async (plannedOn: string | null) => {
    setBusy(true)
    try {
      await todoClient.tasks.schedule(task, plannedOn)
      notify(plannedOn ? `日期已改为 ${plannedOn}` : '已移至待分配', 'success')
      await refresh()
    } catch (error) {
      notify(apiErrorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TaskCardView
        task={task}
        today={today}
        compact={compact}
        todayRow={todayRow}
        busy={busy}
        hideRestoreAction={hideRestoreAction}
        onOpen={() => composer.edit(task)}
        onToggleDone={() => changeStatus('DONE')}
        onCancel={() => changeStatus('CANCELLED')}
        onRestore={() => changeStatus('TODO')}
        onSchedule={schedule}
        onNextStep={() => composer.nextStep(task)}
      />
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.title ?? ''}
        description={confirmation?.description ?? ''}
        confirmLabel={confirmation?.status === 'DONE' ? '仅完成父工作' : '仅取消父工作'}
        danger={confirmation?.status === 'CANCELLED'}
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => confirmation && changeStatus(confirmation.status, confirmation.token)}
      />

    </>
  )
}
