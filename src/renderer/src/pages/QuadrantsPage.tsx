import { useRef, useState, type DragEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TaskItem } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { ErrorState, LoadingState, PageHeader } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'

const quadrants = [
  { key: 'importantUrgent' as const, code: 'Q1', title: '重要且紧急', important: true, urgent: true, tone: 'red' },
  { key: 'importantNotUrgent' as const, code: 'Q2', title: '重要不紧急', important: true, urgent: false, tone: 'blue' },
  { key: 'notImportantUrgent' as const, code: 'Q3', title: '不重要但紧急', important: false, urgent: true, tone: 'amber' },
  { key: 'notImportantNotUrgent' as const, code: 'Q4', title: '不重要不紧急', important: false, urgent: false, tone: 'gray' }
]

type QuadrantKey = typeof quadrants[number]['key']
type QuadrantSnapshot = Awaited<ReturnType<typeof todoClient.quadrants.snapshot>>

export function QuadrantsPage({ today }: { today: string }) {
  const snapshot = useQuery({ queryKey: ['quadrants'], queryFn: todoClient.quadrants.snapshot })
  const queryClient = useQueryClient()
  const composer = useTaskComposer()
  const { notify } = useFeedback()
  const [dragged, setDragged] = useState<{ task: TaskItem; source: QuadrantKey } | null>(null)
  const [dropTarget, setDropTarget] = useState<QuadrantKey | null>(null)
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null)

  const dropTask = async (target: typeof quadrants[number]) => {
    const movement = dragged
    setDragged(null)
    setDropTarget(null)
    if (!movement || movement.source === target.key || movingTaskId) return

    const previous = queryClient.getQueryData<QuadrantSnapshot>(['quadrants']) ?? snapshot.data
    if (!previous) return
    const optimisticTask = { ...movement.task, important: target.important, urgent: target.urgent }
    queryClient.setQueryData<QuadrantSnapshot>(['quadrants'], moveBetweenQuadrants(previous, movement.task.id, target.key, optimisticTask))
    setMovingTaskId(movement.task.id)
    try {
      const updated = await todoClient.tasks.updateContent(movement.task, {
        title: movement.task.title,
        notes: movement.task.notes,
        important: target.important,
        urgent: target.urgent
      })
      queryClient.setQueryData<QuadrantSnapshot>(['quadrants'], (current) => current ? replaceTask(current, updated) : current)
      notify('象限已调整', 'success')
      void queryClient.invalidateQueries({ queryKey: ['quadrants'] })
    } catch (error) {
      queryClient.setQueryData(['quadrants'], previous)
      notify(apiErrorMessage(error), 'error')
    } finally {
      setMovingTaskId(null)
    }
  }

  return (
    <div className="page page--wide">
      <PageHeader title="四象限" actions={<button className="button button--primary" type="button" onClick={() => composer.create()}>＋ 新建任务</button>} />
      {snapshot.isLoading ? <LoadingState /> : snapshot.isError || !snapshot.data ? <ErrorState error={snapshot.error} onRetry={() => snapshot.refetch()} /> : (
        <div className="quadrant-grid">
          {quadrants.map((quadrant) => {
            const isTarget = dropTarget === quadrant.key && dragged?.source !== quadrant.key
            return (
              <section
                className={`quadrant quadrant--${quadrant.tone}${isTarget ? ' is-drop-target' : ''}`}
                key={quadrant.key}
                aria-label={`${quadrant.title}象限`}
                onDragEnter={(event) => {
                  if (!dragged) return
                  event.preventDefault()
                  setDropTarget(quadrant.key)
                }}
                onDragOver={(event) => {
                  if (!dragged) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== quadrant.key) setDropTarget(quadrant.key)
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropTarget === quadrant.key) setDropTarget(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  void dropTask(quadrant)
                }}
              >
                <header><div><span>{quadrant.code}</span><h2>{quadrant.title}</h2></div><em>{snapshot.data[quadrant.key].length}</em></header>
                <div className="quadrant__body">
                  {snapshot.data[quadrant.key].length
                    ? snapshot.data[quadrant.key].map((task) => (
                        <QuadrantTask
                          task={task}
                          today={today}
                          dragging={dragged?.task.id === task.id}
                          busy={movingTaskId === task.id}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', task.id)
                            setDragged({ task, source: quadrant.key })
                          }}
                          onDragEnd={() => { setDragged(null); setDropTarget(null) }}
                          key={task.id}
                        />
                      ))
                    : <div className="quadrant-empty">暂无任务</div>}
                  {isTarget && <div className="quadrant-drop-overlay" aria-hidden="true"><span>放到这里</span></div>}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function QuadrantTask({ task, today, dragging, busy, onDragStart, onDragEnd }: {
  task: TaskItem
  today: string
  dragging: boolean
  busy: boolean
  onDragStart: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const dragAllowed = useRef(false)

  return (
    <div
      className={`quadrant-task${dragging ? ' is-dragging' : ''}`}
      draggable={!busy}
      onMouseDownCapture={(event) => {
        dragAllowed.current = event.button === 0 && !blocksCardDrag(event.target)
      }}
      onDragStart={(event) => {
        if (!dragAllowed.current || busy) {
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
      <TaskCard task={task} today={today} compact />
    </div>
  )
}

function blocksCardDrag(target: EventTarget): boolean {
  if (!(target instanceof Element)) return true
  const control = target.closest('button, input, select, textarea, a, [contenteditable="true"]')
  return Boolean(control && !control.classList.contains('task-card__main'))
}

function moveBetweenQuadrants(snapshot: QuadrantSnapshot, taskId: string, target: QuadrantKey, task: TaskItem): QuadrantSnapshot {
  return {
    importantUrgent: snapshot.importantUrgent.filter((item) => item.id !== taskId),
    importantNotUrgent: snapshot.importantNotUrgent.filter((item) => item.id !== taskId),
    notImportantUrgent: snapshot.notImportantUrgent.filter((item) => item.id !== taskId),
    notImportantNotUrgent: snapshot.notImportantNotUrgent.filter((item) => item.id !== taskId),
    [target]: [...snapshot[target].filter((item) => item.id !== taskId), task]
  }
}

function replaceTask(snapshot: QuadrantSnapshot, task: TaskItem): QuadrantSnapshot {
  return {
    importantUrgent: snapshot.importantUrgent.map((item) => item.id === task.id ? task : item),
    importantNotUrgent: snapshot.importantNotUrgent.map((item) => item.id === task.id ? task : item),
    notImportantUrgent: snapshot.notImportantUrgent.map((item) => item.id === task.id ? task : item),
    notImportantNotUrgent: snapshot.notImportantNotUrgent.map((item) => item.id === task.id ? task : item)
  }
}
