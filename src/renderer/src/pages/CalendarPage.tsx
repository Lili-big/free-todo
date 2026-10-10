import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CalendarItem, ExternalCalendarEvent, ProjectedOccurrence, TaskItem } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'
import { addDays, addMonths, calendarMonthRange, dayNumber, eachDay, endOfIsoWeek, formatDate, monthTitle, sameMonth, startOfIsoWeek } from '../utils/date'

type CalendarMode = 'week' | 'month'
type CalendarDrawerState =
  | { kind: 'item'; item: CalendarItem }
  | { kind: 'day'; date: string }

export function CalendarPage({ today }: { today: string }) {
  const [mode, setMode] = useState<CalendarMode>('month')
  const [anchor, setAnchor] = useState(today)
  const [selectedDate, setSelectedDate] = useState(today)
  const [drawer, setDrawer] = useState<CalendarDrawerState | null>(null)
  const range = useMemo(() => mode === 'week'
    ? { startOn: startOfIsoWeek(anchor), endOn: endOfIsoWeek(anchor) }
    : calendarMonthRange(anchor), [anchor, mode])
  const days = useMemo(() => eachDay(range.startOn, range.endOn), [range.endOn, range.startOn])
  const queryClient = useQueryClient()
  const calendar = useQuery({ queryKey: ['calendar', range.startOn, range.endOn], queryFn: () => todoClient.calendar.range(range.startOn, range.endOn) })
  const externalStatus = useQuery({ queryKey: ['wecom-calendar', 'status'], queryFn: todoClient.wecomCalendar.status, retry: false })
  const externalCalendar = useQuery({
    queryKey: ['wecom-calendar', 'range', range.startOn, range.endOn],
    queryFn: () => todoClient.wecomCalendar.range(range.startOn, range.endOn),
    enabled: externalStatus.data?.connected === true,
    retry: false
  })
  const calendarItems = useMemo<CalendarItem[]>(() => [
    ...(calendar.data ?? []),
    ...(externalCalendar.data ?? [])
  ], [calendar.data, externalCalendar.data])
  const composer = useTaskComposer()
  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    for (const item of calendarItems) {
      for (const date of calendarItemDates(item, range.startOn, range.endOn)) {
        const current = map.get(date) ?? []
        current.push(item)
        map.set(date, current)
      }
    }
    for (const items of map.values()) {
      items.sort((left, right) => calendarItemOrder(left) - calendarItemOrder(right))
    }
    return map
  }, [calendarItems, range.endOn, range.startOn])

  useEffect(() => {
    const status = externalStatus.data
    if (!status?.connected) return
    const covered = Boolean(
      status.cachedRangeStartOn && status.cachedRangeEndOn &&
      status.cachedRangeStartOn <= range.startOn && status.cachedRangeEndOn >= range.endOn
    )
    if (covered) return
    let cancelled = false
    void todoClient.wecomCalendar.sync(range.startOn, range.endOn).then(async (result) => {
      if (cancelled) return
      queryClient.setQueryData(['wecom-calendar', 'status'], result.status)
      await queryClient.invalidateQueries({ queryKey: ['wecom-calendar', 'range', range.startOn, range.endOn] })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [externalStatus.data, queryClient, range.endOn, range.startOn])

  const move = (direction: number) => {
    const next = mode === 'week' ? addDays(anchor, direction * 7) : addMonths(anchor, direction)
    setAnchor(next)
    setSelectedDate(next)
    setDrawer(null)
  }

  const openItem = (event: MouseEvent, item: CalendarItem, displayedOn?: string) => {
    event.stopPropagation()
    setSelectedDate(displayedOn ?? calendarItemDate(item) ?? selectedDate)
    setDrawer({ kind: 'item', item })
  }

  const openDay = (event: MouseEvent, date: string) => {
    event.stopPropagation()
    showDay(date)
  }

  const showDay = (date: string) => {
    setSelectedDate(date)
    setDrawer({ kind: 'day', date })
  }

  return (
    <div className="page page--calendar">
      <header className="calendar-toolbar">
        <div className="calendar-toolbar__main">
          <h1>日历</h1>
          <div className="calendar-toolbar__nav">
            <button className="icon-button" type="button" aria-label="上一段日期" onClick={() => move(-1)}>‹</button>
            <button className="button button--ghost" type="button" onClick={() => { setAnchor(today); setSelectedDate(today); setDrawer(null) }}>今天</button>
            <button className="icon-button" type="button" aria-label="下一段日期" onClick={() => move(1)}>›</button>
            <h2>{mode === 'month' ? monthTitle(anchor) : `${formatDate(range.startOn, { year: false })} — ${formatDate(range.endOn, { year: false })}`}</h2>
          </div>
        </div>
        <div className="calendar-toolbar__actions">
          <div className="segmented"><button type="button" className={mode === 'week' ? 'is-active' : ''} onClick={() => setMode('week')}>周</button><button type="button" className={mode === 'month' ? 'is-active' : ''} onClick={() => setMode('month')}>月</button></div>
          <button className="button button--primary" type="button" onClick={() => composer.create({ plannedOn: selectedDate })}>添加任务</button>
        </div>
      </header>

      {calendar.isLoading ? <LoadingState label="正在加载日历…" /> : calendar.isError ? <ErrorState error={calendar.error} onRetry={() => calendar.refetch()} /> : (
        <section className={`calendar-grid calendar-grid--${mode}`} role="grid" aria-label={mode === 'month' ? '月日历' : '周日历'}>
          {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((weekday) => <div className="calendar-weekday" role="columnheader" key={weekday}>{weekday}</div>)}
          {days.map((date) => {
            const items = itemsByDate.get(date) ?? []
            const limit = mode === 'week' ? 10 : 4
            return (
              <div
                className={`calendar-day${date === today ? ' is-today' : ''}${date === selectedDate ? ' is-selected' : ''}${mode === 'month' && !sameMonth(date, anchor) ? ' is-outside' : ''}`}
                key={date}
                role="gridcell"
                tabIndex={0}
                onClick={() => showDay(date)}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    showDay(date)
                  }
                }}
                aria-label={`${formatDate(date, { weekday: true })}，${items.length} 项安排`}
              >
                <button type="button" className="calendar-day__number" onClick={(event) => openDay(event, date)} aria-label={`查看 ${formatDate(date, { weekday: true })} 的全部任务`}>
                  <span>{dayNumber(date)}</span>
                  <i>{date === today && <em>今天</em>}{items.length > 0 && <small>{items.length} 项</small>}</i>
                </button>
                <span className="calendar-day__items">
                  {items.slice(0, limit).map((item) => <CalendarChip item={item} displayedOn={date} today={today} key={calendarItemKey(item)} onOpen={(event) => openItem(event, item, date)} />)}
                  {items.length > limit && <button type="button" className="calendar-day__more" onClick={(event) => openDay(event, date)}>还有 {items.length - limit} 项</button>}
                </span>
              </div>
            )
          })}
        </section>
      )}

      <CalendarDrawer
        state={drawer}
        items={drawer?.kind === 'day' ? itemsByDate.get(drawer.date) ?? [] : []}
        today={today}
        onClose={() => setDrawer(null)}
        onEdit={(task) => composer.edit(task)}
        onAdd={(date) => composer.create({ plannedOn: date })}
      />
    </div>
  )
}

function CalendarChip({ item, displayedOn, today, onOpen }: {
  item: CalendarItem
  displayedOn: string
  today: string
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  if (item.kind === 'PROJECTED_OCCURRENCE') {
    return <button type="button" className="calendar-chip calendar-chip--projection" aria-label={`查看重复任务“${item.title}”`} onClick={onOpen}><b>↻</b><span>{item.title}</span></button>
  }
  if (item.kind === 'EXTERNAL_EVENT') {
    const historyClass = displayedOn < today ? ' calendar-chip--history' : ''
    return <button type="button" className={`calendar-chip calendar-chip--external${historyClass}`} aria-label={`查看企业微信日程“${item.title}”`} onClick={onOpen}><b>企</b><span>{externalEventStartLabel(item)} {item.title}</span></button>
  }
  return <button type="button" className={`calendar-chip${item.task.status === 'DONE' ? ' is-done' : ''}`} aria-label={`查看任务“${item.task.title}”`} onClick={onOpen}><b>{item.task.status === 'DONE' ? '✓' : item.task.important ? '!' : '·'}</b><span>{item.task.title}</span></button>
}

function CalendarDrawer({ state, items, today, onClose, onEdit, onAdd }: {
  state: CalendarDrawerState | null
  items: CalendarItem[]
  today: string
  onClose: () => void
  onEdit: (task: TaskItem) => void
  onAdd: (date: string) => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!state) return
    const previous = document.activeElement as HTMLElement | null
    const listener = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    if (!document.querySelector('.modal-backdrop')) panelRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', listener)
      previous?.focus()
    }
  }, [onClose, state])

  if (!state) return null
  const date = state.kind === 'day'
    ? state.date
    : calendarItemDate(state.item)
  const visibleItems = state.kind === 'day' ? items : [state.item]
  const title = state.kind === 'day'
    ? formatDate(state.date, { weekday: true })
    : state.item.kind === 'EXTERNAL_EVENT' ? '日程详情' : '任务详情'

  return (
    <div className="calendar-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="calendar-drawer" role="dialog" aria-modal="true" aria-labelledby="calendar-drawer-title" tabIndex={-1} ref={panelRef}>
        <header>
          <div>
            <h2 id="calendar-drawer-title">{title}</h2>
            {date && <span>{date}{state.kind === 'day' ? ` · ${visibleItems.length} 项` : ''}</span>}
          </div>
          <div className="button-row">
            {state.kind === 'day' && <button className="button button--primary" type="button" onClick={() => onAdd(state.date)}>添加任务</button>}
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>
        <div className="calendar-drawer__body">
          {visibleItems.length === 0 && <EmptyState icon="·" title="当天没有安排" />}
          {visibleItems.map((item) => item.kind === 'TASK'
            ? <div className="calendar-drawer__task" key={calendarItemKey(item)}>
                <TaskCard task={item.task} today={today} compact />
                {state.kind === 'item' && item.task.notes && <p className="calendar-drawer__notes">{item.task.notes}</p>}
                {state.kind === 'item' && <button className="button button--secondary" type="button" onClick={() => onEdit(item.task)}>编辑任务</button>}
              </div>
            : item.kind === 'PROJECTED_OCCURRENCE'
              ? <ProjectionCard item={item} key={calendarItemKey(item)} />
              : <ExternalEventCard item={item} key={calendarItemKey(item)} />)}
        </div>
      </aside>
    </div>
  )
}

function calendarItemOrder(item: CalendarItem): number {
  if (item.kind === 'TASK' && item.task.status === 'DONE') return 2
  if (item.kind === 'TASK' && item.task.status === 'CANCELLED') return 3
  return 1
}

function calendarItemDate(item: CalendarItem): string | null {
  if (item.kind === 'TASK') return item.task.plannedOn
  if (item.kind === 'PROJECTED_OCCURRENCE') return item.plannedOn
  return externalLocalDate(item.start)
}

function calendarItemDates(item: CalendarItem, rangeStartOn: string, rangeEndOn: string): string[] {
  const firstDate = calendarItemDate(item)
  if (!firstDate) return []
  if (item.kind !== 'EXTERNAL_EVENT') return firstDate >= rangeStartOn && firstDate <= rangeEndOn ? [firstDate] : []

  const lastDate = externalEventLastDate(item, firstDate)
  const start = firstDate < rangeStartOn ? rangeStartOn : firstDate
  const end = lastDate > rangeEndOn ? rangeEndOn : lastDate
  return start <= end ? eachDay(start, end) : []
}

function externalEventLastDate(item: ExternalCalendarEvent, firstDate: string): string {
  let lastDate = firstDate
  if (item.allDay) {
    const endExclusive = item.end.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(endExclusive) && endExclusive > firstDate) lastDate = addDays(endExclusive, -1)
  } else {
    const endInstant = externalInstant(item.end)
    const startInstant = externalInstant(item.start)
    if (endInstant && (!startInstant || endInstant.getTime() > startInstant.getTime())) {
      lastDate = dateFromLocalInstant(new Date(endInstant.getTime() - 1))
    } else {
      lastDate = externalLocalDate(item.end) ?? firstDate
    }
  }
  if (lastDate < firstDate) lastDate = firstDate
  return lastDate
}

function calendarItemKey(item: CalendarItem): string {
  if (item.kind === 'TASK') return item.task.id
  if (item.kind === 'PROJECTED_OCCURRENCE') return item.occurrenceKey
  return `external:${item.id}:${item.start}`
}

function externalEventTime(item: ExternalCalendarEvent): string {
  if (item.allDay) return '全天'
  return [formatExternalClock(item.start), formatExternalClock(item.end)].filter(Boolean).join('–')
}

function externalEventStartLabel(item: ExternalCalendarEvent): string {
  return item.allDay ? '全天' : formatExternalClock(item.start)
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
}

function externalInstant(value: string): Date | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function externalLocalDate(value: string): string | null {
  if (!hasExplicitOffset(value)) return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null
  const parsed = externalInstant(value)
  return parsed ? dateFromLocalInstant(parsed) : /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null
}

function dateFromLocalInstant(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function formatExternalClock(value: string): string {
  if (hasExplicitOffset(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed)
    }
  }
  return /T(\d{2}:\d{2})/.exec(value)?.[1] ?? ''
}

function ExternalEventCard({ item }: { item: ExternalCalendarEvent }) {
  return (
    <article className="external-event-card">
      <span className="tag tag--neutral">企业微信 · 只读</span>
      <h3>{item.title}</h3>
      <p>{externalEventRangeLabel(item)}{item.location ? ` · ${item.location}` : ''}</p>
    </article>
  )
}

function externalEventRangeLabel(item: ExternalCalendarEvent): string {
  const startDate = externalLocalDate(item.start)
  const endDate = startDate ? externalEventLastDate(item, startDate) : null
  if (item.allDay) {
    return startDate && endDate && startDate !== endDate
      ? `${formatDate(startDate, { year: false })}–${formatDate(endDate, { year: false })} · 全天`
      : startDate ? `${formatDate(startDate, { weekday: true })} · 全天` : '全天'
  }
  const time = externalEventTime(item)
  return startDate && endDate && startDate !== endDate
    ? `${formatDate(startDate, { year: false })} ${formatExternalClock(item.start)}–${formatDate(endDate, { year: false })} ${formatExternalClock(item.end)}`
    : startDate ? `${formatDate(startDate, { weekday: true })} · ${time}` : time
}

function ProjectionCard({ item }: { item: ProjectedOccurrence }) {
  const { notify } = useFeedback()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [newDate, setNewDate] = useState(item.plannedOn)
  const apply = async (action: Record<string, unknown>, message: string) => {
    setBusy(true)
    try {
      await todoClient.recurrences.actOnProjection(item, action)
      notify(message, 'success')
      await queryClient.invalidateQueries()
    } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
  }
  return (
    <article className="projection-card">
      <div className="projection-card__title"><span>↻</span><strong>{item.title}</strong></div>
      {item.project && <p>{item.project.name}</p>}
      <div className="projection-card__actions">
        <button className="mini-button mini-button--accent" type="button" disabled={busy} onClick={() => apply({ kind: 'COMPLETE' }, '本次发生项已完成')}>完成本次</button>
        <button className="mini-button" type="button" disabled={busy} onClick={() => apply({ kind: 'CANCEL' }, '本次发生项已取消')}>取消本次</button>
      </div>
      <label className="projection-card__reschedule"><span>改期</span><input aria-label={`将“${item.title}”改期至`} type="date" value={newDate} onChange={(event) => setNewDate(event.target.value)} /><button className="mini-button" type="button" disabled={busy || !newDate || newDate === item.plannedOn} onClick={() => apply({ kind: 'RESCHEDULE', plannedOn: newDate }, `本次已改期至 ${newDate}`)}>确认</button></label>
    </article>
  )
}
