import type {
  ExternalCalendarStatusDto,
  ExternalEventDto,
  GoalPriority as SharedGoalPriority,
  GoalStatus,
  LocalDate,
  ProjectStatus,
  RecurrenceKind,
  TaskStatus
} from '@shared/types'

export type { GoalStatus, LocalDate, ProjectStatus, RecurrenceKind, TaskStatus }
export type ExternalCalendarStatus = ExternalCalendarStatusDto
export type ExternalCalendarEvent = ExternalEventDto
export type GoalPriority = SharedGoalPriority | null
export type GoalPeriodKind = 'NONE' | 'MONTH' | 'QUARTER' | 'YEAR' | 'CUSTOM'

export interface EntityRef {
  id: string
  name: string
}

export interface TaskItem {
  goal?: EntityRef | null
  id: string
  title: string
  notes: string | null
  plannedOn: LocalDate | null
  plannedStartOn?: LocalDate | null
  status: TaskStatus
  completedOn: LocalDate | null
  cancelledOn?: LocalDate | null
  project: EntityRef | null
  parent: EntityRef | null
  important: boolean
  urgent: boolean
  hasChildren: boolean
  isExecutable: boolean
  pendingChildCount: number
  isOverdue: boolean
  recurrenceSeriesId: string | null
  originalOccurrenceOn: LocalDate | null
  rowVersion: number
  children?: TaskItem[]
  history?: TaskHistoryEvent[]
}

export interface TaskHistoryEvent {
  id: string
  kind: 'STATUS' | 'SCHEDULE'
  changedOn: LocalDate
  changedAtUtc?: number
  oldValue: string | null
  newValue: string | null
  oldPlannedStartOn?: LocalDate | null
  newPlannedStartOn?: LocalDate | null
}

export interface TodaySnapshot {
  today: LocalDate
  showReviewCard: boolean
  overdue: TaskItem[]
  todayTasks: TaskItem[]
  completedToday: TaskItem[]
}

export interface ReviewSnapshot extends TodaySnapshot {
  yesterday: LocalDate
  yesterdayResults: Array<TaskItem & { resultStatus?: TaskStatus; currentStatus?: TaskStatus }>
  planning: TaskItem[]
}

export interface ProjectItem {
  id: string
  name: string
  description: string | null
  goal: EntityRef | null
  status: ProjectStatus
  openTaskCount: number
  executableTaskCount: number
  activeSeriesCount: number
  hasNextAction: boolean
  rowVersion: number
  tasks?: TaskItem[]
}

export interface GoalCategory {
  id: string
  name: string
}

export interface GoalItem {
  id: string
  name: string
  description: string | null
  category: GoalCategory | null
  priority: GoalPriority
  periodKind: GoalPeriodKind
  periodStartOn: LocalDate | null
  periodEndOn: LocalDate | null
  status: GoalStatus
  activeProjectCount: number
  rowVersion: number
  projects?: ProjectItem[]
}

export interface RecurrenceSeriesItem {
  id: string
  title: string
  notes: string | null
  project: EntityRef | null
  important: boolean
  urgent: boolean
  enabled: boolean
  ruleKind: RecurrenceKind
  weekdays: number[]
  monthlyDay: number | null
  startOn: LocalDate
  endOn: LocalDate | null
  rowVersion: number
  nextOccurrenceOn?: LocalDate | null
}

export interface ProjectedOccurrence {
  kind: 'PROJECTED_OCCURRENCE'
  occurrenceKey: string
  seriesId: string
  expectedSeriesRowVersion: number
  appliedRuleVersionId: string
  originalOccurrenceOn: LocalDate
  plannedOn: LocalDate
  title: string
  project: EntityRef | null
  important: boolean
  urgent: boolean
}

export type CalendarItem =
  | { kind: 'TASK'; task: TaskItem }
  | ProjectedOccurrence
  | ExternalCalendarEvent

export interface BackupInspection {
  inspectionToken: string
  confirmationToken: string
  createdAtUtc: number
  applicationVersion: string
  schemaVersion: number
  counts: Record<string, number>
  fileName?: string
}

export interface SafetyBackup {
  id: string
  createdAtUtc: number
  fileName: string
  reason?: string
}

export interface BootstrapInfo {
  today: LocalDate
  appVersion?: string
  dataEpoch?: string
  revision?: number
}

export interface TaskDraft {
  goalId?: string | null
  title: string
  notes?: string | null
  plannedOn?: LocalDate | null
  plannedStartOn?: LocalDate | null
  projectId?: string | null
  parentTaskId?: string | null
  important?: boolean
  urgent?: boolean
}

export interface GoalDraft {
  name: string
  description?: string | null
  categoryId?: string | null
  priority?: GoalPriority
  periodKind: GoalPeriodKind
  periodStartOn?: LocalDate | null
  periodEndOn?: LocalDate | null
}

export interface RecurrenceDraft extends TaskDraft {
  ruleKind: RecurrenceKind
  weekdays?: number[]
  monthlyDay?: number | null
  startOn: LocalDate
  endOn?: LocalDate | null
}

export interface ApiErrorShape {
  code: string
  message: string
  retryable?: boolean
  traceId?: string
  fieldErrors?: Record<string, string[]>
  details?: Record<string, unknown>
}
