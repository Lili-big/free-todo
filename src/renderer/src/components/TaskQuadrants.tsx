import { useRef, useState, type DragEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TaskItem } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from './Feedback'
import { TaskCard } from './TaskCard'

const quadrants = [
  { key: 'importantUrgent' as const, code: 'Q1', title: '重要且紧急', important: true, urgent: true, tone: 'red' },
  { key: 'importantNotUrgent' as const, code: 'Q2', title: '重要不紧急', important: true, urgent: false, tone: 'blue' },
  { key: 'notImportantUrgent' as const, code: 'Q3', title: '不重要但紧急', important: false, urgent: true, tone: 'amber' },
  { key: 'notImportantNotUrgent' as const, code: 'Q4', title: '不重要不紧急', important: false, urgent: false, tone: 'gray' }
]

export function groupTasksByQuadrant(tasks: TaskItem[]) {
  return {
    importantUrgent: tasks.filter((task) => task.important && task.urgent),
    importantNotUrgent: tasks.filter((task) => task.important && !task.urgent),
    notImportantUrgent: tasks.filter((task) => !task.important && task.urgent),
    notImportantNotUrgent: tasks.filter((task) => !task.important && !task.urgent)
  }
}

type QuadrantKey = typeof quadrants[number]['key']

export function TaskQuadrants({ tasks, today, todayRows = false, onTaskUpdated }: {
  tasks: TaskItem[]
  today: string
  todayRows?: boolean
  onTaskUpdated: (task: TaskItem) => void
}) {
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [dragged, setDragged] = useState<{ task: TaskItem; source: QuadrantKey } | null>(null)
  const [dropTarget, setDropTarget] = useState<QuadrantKey | null>(null)
  const [pendingTask, setPendingTask] = useState<TaskItem | null>(null)
  const saving = useRef(false)
  const grouped = groupTasksByQuadrant(tasks.map((task) => pendingTask?.id === task.id ? pendingTask : task))

  const dropTask = async (target: typeof quadrants[number]) => {
    const movement = dragged
    setDragged(null)
    setDropTarget(null)
    if (!movement || movement.source === target.key || saving.current) return
    saving.current = true
    setPendingTask({ ...movement.task, important: target.important, urgent: target.urgent })
    try {
      const updated = await todoClient.tasks.setQuadrant(movement.task, target.important, target.urgent)
      onTaskUpdated(updated)
      notify('象限已调整', 'success')
    } catch (error) {
      notify(apiErrorMessage(error), 'error')
    } finally {
      setPendingTask(null)
      // Refresh all task views, including conflicts resolved by another edit.
      void queryClient.invalidateQueries()
      saving.current = false
    }
  }

  return (
    <div className={`quadrant-grid${todayRows ? ' quadrant-grid--today' : ''}`}>
      {quadrants.map((quadrant) => {
        const isTarget = dropTarget === quadrant.key && dragged?.source !== quadrant.key
        return (
          <section
            className={`quadrant quadrant--${quadrant.tone}${isTarget ? ' is-drop-target' : ''}`}
            key={quadrant.key}
            aria-label={`${quadrant.title}象限`}
            onDragEnter={(event) => {
              if (!dragged || saving.current) return
              event.preventDefault()
              setDropTarget(quadrant.key)
            }}
            onDragOver={(event) => {
              if (!dragged || saving.current) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropTarget(quadrant.key)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropTarget === quadrant.key) setDropTarget(null)
            }}
            onDrop={(event) => {
              if (!dragged) return
              event.preventDefault()
              void dropTask(quadrant)
            }}
          >
            <header><div><span>{quadrant.code}</span><h2>{quadrant.title}</h2></div><em>{grouped[quadrant.key].length}</em></header>
            <div className="quadrant__body">
              {grouped[quadrant.key].length
                ? grouped[quadrant.key].map((task) => (
                    <DraggableTask
                      task={task}
                      today={today}
                      todayRow={todayRows}
                      dragging={dragged?.task.id === task.id}
                      busy={pendingTask?.id === task.id}
                      dragDisabled={Boolean(pendingTask)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', task.id)
                        setDragged({ task, source: quadrant.key })
                      }}
                      onDragEnd={() => { setDragged(null); setDropTarget(null) }}
                      key={task.id}
                    />
                  ))
                : <div className="quadrant-empty">{todayRows ? '暂无任务，可拖动任务到这里' : '暂无任务'}</div>}
              {isTarget && <div className="quadrant-drop-overlay" aria-hidden="true"><span>放到这里</span></div>}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function DraggableTask({ task, today, todayRow, dragging, busy, dragDisabled, onDragStart, onDragEnd }: {
  task: TaskItem
  today: string
  todayRow: boolean
  dragging: boolean
  busy: boolean
  dragDisabled: boolean
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const dragAllowed = useRef(false)

  return (
    <div
      className={`quadrant-task${dragging ? ' is-dragging' : ''}`}
      draggable={!dragDisabled}
      onMouseDownCapture={(event) => {
        const control = event.target instanceof Element
          ? event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')
          : null
        dragAllowed.current = event.button === 0 && (!control || control.classList.contains('task-card__main'))
      }}
      onDragStart={(event) => {
        if (!dragAllowed.current || dragDisabled) {
          event.preventDefault()
          return
        }
        onDragStart(event)
      }}
      onDragEnd={() => {
        dragAllowed.current = false
        onDragEnd()
      }}
    >
      <TaskCard task={task} today={today} compact={!todayRow} todayRow={todayRow} disabled={busy} />
    </div>
  )
}
