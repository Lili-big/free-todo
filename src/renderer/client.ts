import type {
  ApiErrorShape,
  BackupInspection,
  BootstrapInfo,
  CalendarItem,
  ExternalCalendarEvent,
  ExternalCalendarStatus,
  GoalCategory,
  GoalDraft,
  GoalItem,
  ProjectItem,
  RecurrenceDraft,
  RecurrenceSeriesItem,
  ReviewSnapshot,
  SafetyBackup,
  TaskDraft,
  TaskHistoryEvent,
  TaskItem,
  TodaySnapshot
} from './domain'
import type { TodoDesktopApi } from '@shared/api'

type RawRecord = Record<string, unknown>
type RawMethod = (...args: unknown[]) => unknown
type RawApi = TodoDesktopApi & Record<string, unknown>

export class TodoApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly traceId?: string
  readonly fieldErrors?: Record<string, string[]>
  readonly details?: Record<string, unknown>

  constructor(error: ApiErrorShape) {
    super(error.message || '操作失败，请稍后再试')
    this.name = 'TodoApiError'
    this.code = error.code || 'INTERNAL_ERROR'
    this.retryable = Boolean(error.retryable)
    this.traceId = error.traceId
    this.fieldErrors = error.fieldErrors
    this.details = error.details
  }
}

function rawApi(): RawApi {
  const api = (window as unknown as { todoApi?: RawApi }).todoApi
  if (!api) {
    throw new TodoApiError({
      code: 'API_UNAVAILABLE',
      message: '应用服务尚未就绪，请重新启动应用。'
    })
  }
  return api as RawApi
}

function valueAtPath(source: RawApi, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as RawRecord)[key]
  }, source)
}

async function call<T>(path: string, input?: unknown): Promise<T> {
  const api = rawApi()
  const method = valueAtPath(api, path)
  if (typeof method !== 'function') {
    throw new TodoApiError({
      code: 'API_METHOD_UNAVAILABLE',
      message: `当前应用版本不支持此操作（${path}）。`
    })
  }
  const result = await (input === undefined
    ? (method as RawMethod)()
    : (method as RawMethod)(input))
  if (result && typeof result === 'object' && 'ok' in result) {
    const envelope = result as { ok: boolean; data?: unknown; error?: ApiErrorShape }
    if (!envelope.ok) {
      throw new TodoApiError(
        envelope.error ?? { code: 'INTERNAL_ERROR', message: '操作失败，请稍后再试。' }
      )
    }
    return envelope.data as T
  }
  return result as T
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === 'object' ? (value as RawRecord) : {}
}

function mutationValue(value: unknown): unknown {
  const record = asRecord(value)
  return 'value' in record ? record.value : value
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function bool(value: unknown): boolean {
  return value === true || value === 1
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function ref(value: unknown, idFallback?: unknown, nameFallback?: unknown) {
  const item = asRecord(value)
  const id = text(item.id, text(idFallback))
  if (!id) return null
  return { id, name: text(item.name, text(item.title, text(nameFallback, '未命名'))) }
}

export function normalizeTask(value: unknown): TaskItem {
  const item = asRecord(value)
  const children = list(item.children).map(normalizeTask)
  const recurrence = asRecord(item.recurrence)
  return {
    id: text(item.id),
    title: text(item.title, '未命名任务'),
    notes: optionalText(item.notes ?? item.note),
    plannedOn: optionalText(item.plannedOn ?? item.plannedDate),
    status: (text(item.status, 'TODO') as TaskItem['status']),
    completedOn: optionalText(item.completedOn ?? item.completedDate),
    cancelledOn: optionalText(item.cancelledOn ?? item.cancelledDate),
    project: ref(item.project, item.projectId, item.projectName),
    goal: ref(item.goal),
    parent: ref(item.parent, item.parentTaskId, item.parentTitle),
    important: bool(item.important ?? item.isImportant ?? item.is_important),
    urgent: bool(item.urgent ?? item.isUrgent ?? item.is_urgent),
    hasChildren: bool(item.hasChildren) || children.length > 0,
    isExecutable: item.isExecutable === undefined
      ? !(bool(item.hasChildren) || children.length > 0)
      : bool(item.isExecutable),
    pendingChildCount: num(item.pendingChildCount),
    isOverdue: bool(item.isOverdue),
    recurrenceSeriesId: optionalText(item.recurrenceSeriesId ?? recurrence.seriesId),
    originalOccurrenceOn: optionalText(item.originalOccurrenceOn ?? item.originalOccurrenceDate ?? recurrence.originalOccurrenceOn),
    rowVersion: num(item.rowVersion ?? item.version, 1),
    children,
    history: list(item.history).map(normalizeHistoryEvent)
  }
}

function normalizeHistoryEvent(raw: unknown): TaskHistoryEvent {
  const item = asRecord(raw)
  return {
    id: text(item.id),
    kind: text(item.kind, item.oldStatus !== undefined ? 'STATUS' : 'SCHEDULE') as TaskHistoryEvent['kind'],
    changedOn: text(item.changedOn),
    changedAtUtc: typeof item.changedAtUtc === 'string' ? Date.parse(item.changedAtUtc) : num(item.changedAtUtc),
    oldValue: optionalText(item.oldValue ?? item.oldStatus ?? item.oldPlannedOn),
    newValue: optionalText(item.newValue ?? item.newStatus ?? item.newPlannedOn)
  }
}

function taskArray(source: RawRecord, ...keys: string[]): TaskItem[] {
  for (const key of keys) {
    if (Array.isArray(source[key])) return list(source[key]).map(normalizeTask)
  }
  return []
}

function normalizeToday(value: unknown): TodaySnapshot {
  const data = asRecord(value)
  return {
    today: text(data.today ?? data.localDate),
    showReviewCard: data.showReviewCard === undefined
      ? data.reviewCardState !== undefined
        ? data.reviewCardState === 'VISIBLE'
        : !bool(data.reviewCardDismissed)
      : bool(data.showReviewCard),
    overdue: taskArray(data, 'overdue', 'legacyTasks', 'overdueTasks'),
    todayTasks: taskArray(data, 'todayTasks', 'tasks', 'scheduledToday', 'dueToday'),
    completedToday: taskArray(data, 'completedToday', 'todayCompleted')
  }
}

function normalizeProject(value: unknown): ProjectItem {
  const item = asRecord(value)
  return {
    id: text(item.id),
    name: text(item.name, '未命名项目'),
    description: optionalText(item.description),
    goal: ref(item.goal, item.goalId, item.goalName),
    status: text(item.status, 'ACTIVE') as ProjectItem['status'],
    openTaskCount: num(item.openTaskCount ?? item.pendingTaskCount),
    executableTaskCount: num(item.executableTaskCount ?? item.pendingExecutableCount),
    activeSeriesCount: num(item.activeSeriesCount ?? item.enabledSeriesCount),
    hasNextAction: item.hasNextAction === undefined
      ? num(item.executableTaskCount) > 0
      : bool(item.hasNextAction),
    rowVersion: num(item.rowVersion ?? item.version, 1),
    tasks: taskArray(item, 'tasks', 'taskTree')
  }
}

function normalizeGoal(value: unknown): GoalItem {
  const item = asRecord(value)
  const categoryValue = ref(item.category, item.categoryId, item.categoryName)
  return {
    id: text(item.id),
    name: text(item.name, '未命名目标'),
    description: optionalText(item.description),
    category: categoryValue,
    priority: optionalText(item.priority) as GoalItem['priority'],
    periodKind: text(item.periodKind ?? asRecord(item.period).kind, 'NONE') as GoalItem['periodKind'],
    periodStartOn: optionalText(item.periodStartOn ?? asRecord(item.period).startOn),
    periodEndOn: optionalText(item.periodEndOn ?? asRecord(item.period).endOn),
    status: text(item.status, 'ACTIVE') as GoalItem['status'],
    activeProjectCount: num(item.activeProjectCount),
    rowVersion: num(item.rowVersion ?? item.version, 1),
    projects: list(item.projects).map(normalizeProject)
  }
}

function normalizeSeries(value: unknown): RecurrenceSeriesItem {
  const item = asRecord(value)
  const rule = asRecord(item.rule ?? item.currentRule)
  const source = Object.keys(rule).length ? { ...item, ...rule } : item
  return {
    id: text(source.id ?? item.id),
    title: text(source.title, '未命名重复事项'),
    notes: optionalText(source.notes),
    project: ref(source.project, source.projectId, source.projectName),
    important: bool(source.important ?? source.isImportant),
    urgent: bool(source.urgent ?? source.isUrgent),
    enabled: source.enabled === undefined ? true : bool(source.enabled),
    ruleKind: text(source.ruleKind ?? asRecord(source.pattern).kind, 'DAILY') as RecurrenceSeriesItem['ruleKind'],
    weekdays: list(source.weekdays ?? asRecord(source.pattern).weekdays).filter((v): v is number => typeof v === 'number'),
    monthlyDay: typeof (source.monthlyDay ?? asRecord(source.pattern).monthlyDay) === 'number'
      ? (source.monthlyDay ?? asRecord(source.pattern).monthlyDay) as number
      : null,
    startOn: text(source.startOn ?? source.ruleStartOn),
    endOn: optionalText(source.endOn ?? source.ruleEndOn),
    rowVersion: num(item.rowVersion ?? item.version, 1),
    nextOccurrenceOn: optionalText(item.nextOccurrenceOn)
  }
}

function normalizeExternalEvent(value: unknown): ExternalCalendarEvent {
  const item = asRecord(value)
  return {
    kind: 'EXTERNAL_EVENT',
    id: text(item.id),
    source: 'WECOM_CALDAV',
    title: text(item.title, '未命名日程'),
    start: text(item.start),
    end: text(item.end),
    allDay: bool(item.allDay),
    location: optionalText(item.location),
    timeZone: optionalText(item.timeZone)
  }
}

function normalizeExternalCalendarStatus(value: unknown): ExternalCalendarStatus {
  const item = asRecord(value)
  const lastErrorCode = optionalText(item.lastErrorCode)
  return {
    source: 'WECOM_CALDAV',
    connected: bool(item.connected),
    syncing: bool(item.syncing),
    serverHost: optionalText(item.serverHost),
    accountHint: optionalText(item.accountHint),
    lastAttemptAtUtc: optionalText(item.lastAttemptAtUtc),
    lastSuccessAtUtc: optionalText(item.lastSuccessAtUtc),
    lastErrorCode: lastErrorCode === 'AUTH_FAILED' || lastErrorCode === 'NETWORK' || lastErrorCode === 'PROTOCOL' || lastErrorCode === 'STORAGE'
      ? lastErrorCode
      : null,
    cachedEventCount: num(item.cachedEventCount),
    cachedRangeStartOn: optionalText(item.cachedRangeStartOn),
    cachedRangeEndOn: optionalText(item.cachedRangeEndOn)
  }
}

function taskInput(input: TaskDraft): RawRecord {
  return {
    goalId: input.goalId ?? null,
    title: input.title,
    notes: input.notes ?? null,
    plannedOn: input.plannedOn ?? null,
    projectId: input.projectId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    important: input.important ?? false,
    urgent: input.urgent ?? false
  }
}

export const todoClient = {
  app: {
    bootstrap: async () => {
      const data = asRecord(await call<unknown>('app.getBootstrap'))
      return {
        today: text(data.today ?? data.localDate),
        appVersion: optionalText(data.appVersion) ?? undefined,
        dataEpoch: optionalText(data.dataEpoch) ?? undefined,
        revision: num(data.revision)
      } satisfies BootstrapInfo
    },
    reconcile: async () => {
      const data = asRecord(mutationValue(await call<unknown>('app.reconcile')))
      return { today: text(data.today ?? data.localDate) } satisfies BootstrapInfo
    },
    preferences: async (): Promise<{ launchAtLogin: boolean }> => {
      const data = asRecord(await call<unknown>('app.getPreferences'))
      return { launchAtLogin: Boolean(data.launchAtLogin) }
    },
    setLaunchAtLogin: async (enabled: boolean): Promise<{ launchAtLogin: boolean }> => {
      const data = asRecord(await call<unknown>('app.setLaunchAtLogin', { enabled }))
      return { launchAtLogin: Boolean(data.launchAtLogin) }
    },
    subscribe(onNotice: (notice: unknown) => void): () => void {
      const api = rawApi()
      const method = valueAtPath(api, 'app.onChanged') ?? valueAtPath(api, 'app.subscribeChanges')
      const replacedMethod = valueAtPath(api, 'app.onDatabaseReplaced')
      const unsubscribers: Array<() => void> = []
      if (typeof method === 'function') {
        const unsubscribe = (method as RawMethod)(onNotice)
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe as () => void)
      }
      if (typeof replacedMethod === 'function') {
        const unsubscribe = (replacedMethod as RawMethod)((notice: unknown) => {
          const item = asRecord(notice)
          onNotice({ ...item, databaseReplaced: true })
        })
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe as () => void)
      }
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  },
  today: {
    snapshot: async () => normalizeToday(await call<unknown>('today.getSnapshot')),
    review: async (): Promise<ReviewSnapshot> => {
      const data = asRecord(await call<unknown>('today.getReviewSnapshot'))
      const base = normalizeToday(data)
      return {
        ...base,
        yesterday: text(data.yesterday),
        yesterdayResults: (() => {
          const source = Array.isArray(data.yesterdayOutcomes)
            ? list(data.yesterdayOutcomes)
            : Array.isArray(data.yesterdayResults)
              ? list(data.yesterdayResults)
              : list(data.yesterdayReview)
          return source.map((raw) => {
            const result = asRecord(raw)
            const task = normalizeTask(result.task ?? result)
            const outcome = text(result.outcome)
            return {
              ...task,
              status: outcome === 'COMPLETED' ? 'DONE' as const : outcome === 'CANCELLED' ? 'CANCELLED' as const : task.status,
              resultStatus: outcome === 'COMPLETED' ? 'DONE' as const : outcome === 'CANCELLED' ? 'CANCELLED' as const : task.status,
              currentStatus: task.status
            }
          })
        })(),
        planning: taskArray(data, 'planning', 'planningTasks', 'unscheduledTasks', 'unscheduled')
      }
    },
    dismissReviewCard: (expectedLocalDate: string) => call('today.dismissReviewCard', { expectedLocalDate }),
    finishReview: (expectedLocalDate: string) => call('today.finishReview', { expectedLocalDate })
  },
  planning: {
    snapshot: async () => {
      const data = await call<unknown>('planning.getSnapshot')
      const record = asRecord(data)
      return Array.isArray(data) ? data.map(normalizeTask) : taskArray(record, 'tasks', 'planning')
    }
  },
  tasks: {
    list: async (filters: RawRecord = {}) => {
      const requestedSize = typeof filters.pageSize === 'number' ? filters.pageSize : 100
      const pageSize = Math.min(500, Math.max(1, requestedSize))
      const firstPage = typeof filters.page === 'number' ? filters.page : 1
      const firstData = await call<unknown>('tasks.list', { ...filters, page: firstPage, pageSize })
      if (Array.isArray(firstData)) return firstData.map(normalizeTask)
      const firstRecord = asRecord(firstData)
      const items = taskArray(firstRecord, 'tasks', 'items')
      const total = num(firstRecord.total, items.length)
      const wanted = Math.min(total, requestedSize)
      let page = firstPage + 1
      while (items.length < wanted) {
        const nextData = asRecord(await call<unknown>('tasks.list', { ...filters, page, pageSize }))
        const nextItems = taskArray(nextData, 'tasks', 'items')
        if (!nextItems.length) break
        items.push(...nextItems)
        page += 1
      }
      return items.slice(0, wanted)
    },
    detail: async (taskId: string) => normalizeTask(await call('tasks.getDetail', { id: taskId })),
    history: async (taskId: string): Promise<TaskHistoryEvent[]> => {
      const detail = asRecord(await call<unknown>('tasks.getDetail', { id: taskId }))
      const source = list(detail.history)
      return source.map(normalizeHistoryEvent)
    },
    create: async (input: TaskDraft) => normalizeTask(mutationValue(await call('tasks.create', taskInput(input)))),
    updateContent: async (task: TaskItem, input: TaskDraft) => normalizeTask(mutationValue(await call('tasks.updateContent', {
      goalId: input.goalId,
      id: task.id,
      expectedVersion: task.rowVersion,
      title: input.title,
      notes: input.notes ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false
    }))),
    schedule: async (task: TaskItem, plannedOn: string | null) => normalizeTask(mutationValue(await call('tasks.setSchedule', {
      id: task.id,
      expectedVersion: task.rowVersion,
      plannedOn
    }))),
    setQuadrant: async (task: TaskItem, important: boolean, urgent: boolean) => normalizeTask(mutationValue(await call('tasks.updateContent', {
      id: task.id,
      expectedVersion: task.rowVersion,
      important,
      urgent
    }))),
    setStatus: async (task: TaskItem, status: TaskItem['status'], confirmationToken?: string) => normalizeTask(mutationValue(await call('tasks.changeStatus', {
      id: task.id,
      expectedVersion: task.rowVersion,
      status,
      confirmationToken
    }))),
    addChild: async (parent: TaskItem, input: TaskDraft) => normalizeTask(mutationValue(await call('tasks.createChild', {
      goalId: input.goalId ?? null,
      parentId: parent.id,
      parentExpectedVersion: parent.rowVersion,
      title: input.title,
      notes: input.notes ?? null,
      plannedOn: input.plannedOn ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false
    }))),
    createNextStep: async (source: TaskItem, input: TaskDraft) => normalizeTask(mutationValue(await call('tasks.createNextStep', {
      goalId: input.goalId ?? null,
      sourceTaskId: source.id,
      title: input.title,
      notes: input.notes ?? null,
      plannedOn: input.plannedOn ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false
    }))),
    moveGroupProject: async (task: TaskItem, projectId: string | null, confirmationToken?: string) => normalizeTask(mutationValue(await call('tasks.moveTree', {
      id: task.id,
      expectedVersion: task.rowVersion,
      projectId,
      confirmationToken
    }))),
    attachParent: async (task: TaskItem, parentId: string, confirmationToken?: string) => normalizeTask(mutationValue(await call('tasks.changeParent', {
      id: task.id,
      expectedVersion: task.rowVersion,
      parentId,
      confirmationToken
    }))),
    createParentAndAttach: async (task: TaskItem, title: string) => normalizeTask(mutationValue(await call('tasks.createParentAndAttach', {
      childId: task.id,
      childExpectedVersion: task.rowVersion,
      title
    }))),
    detachParent: async (task: TaskItem) => normalizeTask(mutationValue(await call('tasks.changeParent', {
      id: task.id,
      expectedVersion: task.rowVersion,
      parentId: null
    })))
  },
  calendar: {
    range: async (startOn: string, endOn: string): Promise<CalendarItem[]> => {
      const data = await call<unknown>('calendar.getRange', { startOn, endOn })
      const record = asRecord(data)
      const source = Array.isArray(data)
        ? data
        : Array.isArray(record.days)
          ? list(record.days).flatMap((day) => list(asRecord(day).items))
          : list(record.items)
      return source.map((raw): CalendarItem => {
        const item = asRecord(raw)
        if (item.kind === 'PROJECTED_OCCURRENCE') {
          return {
            kind: 'PROJECTED_OCCURRENCE',
            occurrenceKey: text(item.occurrenceKey),
            seriesId: text(item.seriesId),
            expectedSeriesRowVersion: num(item.expectedSeriesRowVersion),
            appliedRuleVersionId: text(item.appliedRuleVersionId),
            originalOccurrenceOn: text(item.originalOccurrenceOn ?? item.originalOccurrenceDate),
            plannedOn: text(item.plannedOn ?? item.plannedDate),
            title: text(item.title),
            project: ref(item.project, item.projectId, item.projectName),
            important: bool(item.important),
            urgent: bool(item.urgent)
          }
        }
        return { kind: 'TASK', task: normalizeTask(item.task ?? item) }
      })
    }
  },
  wecomCalendar: {
    status: async (): Promise<ExternalCalendarStatus> => normalizeExternalCalendarStatus(await call('wecomCalendar.getStatus')),
    connect: async (input: { server: string; account?: string; username?: string; password: string }): Promise<ExternalCalendarStatus> =>
      normalizeExternalCalendarStatus(await call('wecomCalendar.connect', input)),
    disconnect: async (): Promise<ExternalCalendarStatus> => normalizeExternalCalendarStatus(await call('wecomCalendar.disconnect')),
    sync: async (startOn: string, endOn: string): Promise<{ status: ExternalCalendarStatus; receivedEventCount: number }> => {
      const value = asRecord(await call('wecomCalendar.sync', { startOn, endOn }))
      return {
        status: normalizeExternalCalendarStatus(value.status),
        receivedEventCount: num(value.receivedEventCount)
      }
    },
    range: async (startOn: string, endOn: string): Promise<ExternalCalendarEvent[]> => {
      const value = await call<unknown>('wecomCalendar.getRange', { startOn, endOn })
      const record = asRecord(value)
      return list(record.items).map(normalizeExternalEvent)
    }
  },
  quadrants: {
    snapshot: async () => {
      const data = asRecord(await call<unknown>('quadrants.getSnapshot'))
      const quadrants = asRecord(data.quadrants)
      const allTasks = taskArray(data, 'tasks')
      const from = (keys: string[], important: boolean, urgent: boolean) => {
        for (const key of keys) {
          if (Array.isArray(data[key])) return list(data[key]).map(normalizeTask)
          const sharedKey = key === 'q1' ? 'Q1' : key === 'q2' ? 'Q2' : key === 'q3' ? 'Q3' : key === 'q4' ? 'Q4' : key
          if (Array.isArray(quadrants[sharedKey])) return list(quadrants[sharedKey]).map(normalizeTask)
        }
        return allTasks.filter((task) => task.important === important && task.urgent === urgent)
      }
      return {
        importantUrgent: from(['importantUrgent', 'q1'], true, true),
        importantNotUrgent: from(['importantNotUrgent', 'q2'], true, false),
        notImportantUrgent: from(['notImportantUrgent', 'q3'], false, true),
        notImportantNotUrgent: from(['notImportantNotUrgent', 'q4'], false, false)
      }
    }
  },
  projects: {
    list: async () => {
      const data = await call<unknown>('projects.list')
      return (Array.isArray(data) ? data : list(asRecord(data).projects)).map(normalizeProject)
    },
    detail: async (projectId: string) => normalizeProject(await call('projects.getDetail', { id: projectId })),
    create: (input: { name: string; description?: string | null; goalId?: string | null }) => call('projects.create', input),
    update: (project: ProjectItem, input: { name: string; description?: string | null; goalId?: string | null }) => call('projects.update', {
      id: project.id,
      expectedVersion: project.rowVersion,
      ...input
    }),
    setStatus: (project: ProjectItem, status: ProjectItem['status']) => call('projects.changeStatus', {
      id: project.id,
      expectedVersion: project.rowVersion,
      status
    }),
    remove: (project: ProjectItem) => call('projects.remove', { id: project.id, expectedVersion: project.rowVersion })
  },
  goals: {
    list: async (filters: RawRecord = {}) => {
      const data = await call<unknown>('goals.list', filters)
      return (Array.isArray(data) ? data : list(asRecord(data).goals)).map(normalizeGoal)
    },
    detail: async (goalId: string) => normalizeGoal(await call('goals.getDetail', { id: goalId })),
    create: (input: GoalDraft) => call('goals.create', {
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      priority: input.priority ?? null,
      period: input.periodKind === 'NONE'
        ? { kind: 'NONE', startOn: null, endOn: null }
        : { kind: input.periodKind, startOn: input.periodStartOn, endOn: input.periodEndOn }
    }),
    update: (goal: GoalItem, input: GoalDraft) => call('goals.update', {
      id: goal.id,
      expectedVersion: goal.rowVersion,
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      priority: input.priority ?? null,
      period: input.periodKind === 'NONE'
        ? { kind: 'NONE', startOn: null, endOn: null }
        : { kind: input.periodKind, startOn: input.periodStartOn, endOn: input.periodEndOn }
    }),
    setStatus: (goal: GoalItem, status: GoalItem['status'], period?: Partial<GoalDraft>, confirmationToken?: string) => call('goals.changeStatus', {
      id: goal.id,
      expectedVersion: goal.rowVersion,
      status,
      period: period
        ? period.periodKind === 'NONE'
          ? { kind: 'NONE', startOn: null, endOn: null }
          : { kind: period.periodKind, startOn: period.periodStartOn, endOn: period.periodEndOn }
        : undefined,
      confirmationToken
    }),
    remove: (goal: GoalItem) => call('goals.remove', { id: goal.id, expectedVersion: goal.rowVersion })
  },
  categories: {
    list: async (): Promise<GoalCategory[]> => {
      const data = await call<unknown>('goalCategories.list')
      const source = Array.isArray(data) ? data : list(asRecord(data).categories)
      return source.map((raw) => {
        const item = asRecord(raw)
        return { id: text(item.id), name: text(item.name) }
      })
    },
    create: (name: string) => call('goalCategories.create', { name }),
    rename: (category: GoalCategory, name: string) => call('goalCategories.rename', { id: category.id, name }),
    remove: (categoryId: string) => call('goalCategories.remove', { id: categoryId })
  },
  recurrences: {
    list: async () => {
      const data = await call<unknown>('recurrences.list')
      return (Array.isArray(data) ? data : list(asRecord(data).series)).map(normalizeSeries)
    },
    detail: async (seriesId: string) => normalizeSeries(await call('recurrences.getDetail', { id: seriesId })),
    create: (input: RecurrenceDraft) => call('recurrences.create', {
      title: input.title,
      notes: input.notes ?? null,
      projectId: input.projectId ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false,
      startOn: input.startOn,
      endOn: input.endOn ?? null,
      pattern: { kind: input.ruleKind, weekdays: input.weekdays ?? [], monthlyDay: input.monthlyDay ?? null }
    }),
    update: (series: RecurrenceSeriesItem, input: RecurrenceDraft, effectiveFromOn: string) => call('recurrences.updateFromDate', {
      id: series.id,
      expectedVersion: series.rowVersion,
      effectiveOn: effectiveFromOn,
      title: input.title,
      notes: input.notes ?? null,
      projectId: input.projectId ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false,
      startOn: input.startOn,
      endOn: input.endOn ?? null,
      pattern: { kind: input.ruleKind, weekdays: input.weekdays ?? [], monthlyDay: input.monthlyDay ?? null }
    }),
    setEnabled: (series: RecurrenceSeriesItem, enabled: boolean, effectiveFromOn: string) => call('recurrences.setEnabledFromDate', {
      id: series.id,
      expectedVersion: series.rowVersion,
      effectiveOn: effectiveFromOn,
      enabled
    }),
    actOnProjection: (item: Extract<CalendarItem, { kind: 'PROJECTED_OCCURRENCE' }>, action: RawRecord) => call('recurrences.applyProjectedOccurrence', {
      seriesId: item.seriesId,
      originalOccurrenceOn: item.originalOccurrenceOn,
      expectedSeriesRowVersion: item.expectedSeriesRowVersion,
      appliedRuleVersionId: item.appliedRuleVersionId,
      action
    })
  },
  backups: {
    exportInteractive: () => call<{ cancelled?: boolean; fileName?: string }>('backups.exportInteractive'),
    inspectInteractive: async () => {
      const value = await call<unknown>('backups.selectAndInspectRestore')
      const item = asRecord(value)
      if (item.cancelled === true) return null
      return {
        inspectionToken: text(item.inspectionToken),
        confirmationToken: text(item.confirmationToken),
        createdAtUtc: Date.parse(text(item.createdAtUtc)) || 0,
        applicationVersion: text(item.applicationVersion),
        schemaVersion: num(item.schemaVersion),
        counts: asRecord(item.counts) as Record<string, number>,
        fileName: text(item.displayName)
      } satisfies BackupInspection
    },
    restore: (inspectionToken: string, confirmationToken: string) => call('backups.restore', { inspectionToken, confirmationToken }),
    subscribeProgress(listener: (progress: unknown) => void): () => void {
      const api = rawApi()
      const method = valueAtPath(api, 'backups.onProgress')
      if (typeof method !== 'function') return () => undefined
      const unsubscribe = (method as RawMethod)(listener)
      return typeof unsubscribe === 'function' ? unsubscribe as () => void : () => undefined
    },
    safetyList: async (): Promise<SafetyBackup[]> => {
      const data = await call<unknown>('backups.listSafetyBackups')
      return (Array.isArray(data) ? data : list(asRecord(data).backups)).map((raw) => {
        const item = asRecord(raw)
        return {
          id: text(item.id),
          createdAtUtc: Date.parse(text(item.createdAtUtc)) || num(item.createdAtUtc),
          fileName: text(item.fileName ?? item.displayName),
          reason: optionalText(item.reason) ?? undefined
        }
      })
    }
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof TodoApiError) {
    const trace = error.traceId ? `\n错误编号：${error.traceId}` : ''
    return `${error.message}${trace}`
  }
  return error instanceof Error ? error.message : '发生未知错误，请稍后再试。'
}
