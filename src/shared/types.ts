export type LocalDate = string
export type EntityId = string
export type UtcTimestamp = string

export type TaskStatus = 'TODO' | 'DONE' | 'CANCELLED'
export type ProjectStatus = 'ACTIVE' | 'COMPLETED'
export type GoalStatus = 'ACTIVE' | 'PAUSED' | 'REVIEW_REQUIRED' | 'COMPLETED' | 'ABANDONED'
export type GoalPriority = 'P0' | 'P1' | 'P2' | 'P3'
export type RecurrenceKind = 'DAILY' | 'WEEKLY' | 'MONTHLY'
export type ExternalCalendarSource = 'WECOM_CALDAV'

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STALE_DAY_CONTEXT'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_EXPIRED'
  | 'TASK_DEPTH_EXCEEDED'
  | 'PARENT_PROJECT_MISMATCH'
  | 'PARENT_NOT_ACTIVE'
  | 'RECURRENCE_RELATION_FORBIDDEN'
  | 'PROJECT_COMPLETED'
  | 'PROJECT_HAS_OPEN_TASKS'
  | 'PROJECT_HAS_ACTIVE_SERIES'
  | 'GOAL_PERIOD_INVALID'
  | 'RECURRENCE_RULE_INVALID'
  | 'OCCURRENCE_STALE'
  | 'BACKUP_CORRUPTED'
  | 'BACKUP_UNSUPPORTED_VERSION'
  | 'BACKUP_INCOMPLETE'
  | 'BACKUP_INVALID_RELATION'
  | 'SAFETY_BACKUP_FAILED'
  | 'RESTORE_FAILED'
  | 'MAINTENANCE_MODE'
  | 'DATABASE_ERROR'
  | 'FILE_IO_ERROR'
  | 'EXTERNAL_CALENDAR_NOT_CONNECTED'
  | 'EXTERNAL_CALENDAR_AUTH_FAILED'
  | 'EXTERNAL_CALENDAR_SYNC_FAILED'
  | 'CREDENTIAL_STORAGE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export interface ApiErrorDto {
  code: ErrorCode
  message: string
  retryable: boolean
  traceId: string
  fieldErrors?: Record<string, string[]>
  details?: Record<string, unknown>
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorDto }

export type InvalidateTag =
  | 'TODAY'
  | 'REVIEW'
  | 'PLANNING'
  | 'TASKS'
  | 'CALENDAR'
  | 'QUADRANTS'
  | 'PROJECTS'
  | 'GOALS'
  | 'RECURRENCES'
  | 'SETTINGS'
  | 'ALL'

export interface ChangeNoticeDto {
  dataEpoch: string
  revision: number
  reason: string
  tags: InvalidateTag[]
  entityIds?: {
    tasks?: EntityId[]
    projects?: EntityId[]
    goals?: EntityId[]
    recurrenceSeries?: EntityId[]
  }
}

export interface MutationEnvelope<T> {
  value: T
  change: ChangeNoticeDto
}

export interface EntityRefDto {
  id: EntityId
  name: string
}

export interface TaskContextRefDto {
  id: EntityId
  title: string
  status: TaskStatus
}

export interface TaskListItemDto {
  goal?: EntityRefDto | null
  id: EntityId
  version: number
  title: string
  notes?: string | null
  status: TaskStatus
  plannedOn: LocalDate | null
  plannedStartOn?: LocalDate | null
  completedOn: LocalDate | null
  cancelledOn: LocalDate | null
  important: boolean
  urgent: boolean
  project: (EntityRefDto & { status: ProjectStatus }) | null
  parent: TaskContextRefDto | null
  hasChildren: boolean
  isExecutable: boolean
  pendingChildCount: number
  isOverdue: boolean
  recurrence: {
    seriesId: EntityId
    originalOccurrenceOn: LocalDate
    isException: boolean
  } | null
  createdAtUtc: UtcTimestamp
  updatedAtUtc: UtcTimestamp
}

export interface TaskHistoryEventDto {
  id: EntityId
  eventSeq: number
  kind: 'STATUS' | 'SCHEDULE'
  changedOn: LocalDate
  changedAtUtc: UtcTimestamp
  oldValue: string | null
  newValue: string | null
  oldPlannedStartOn?: LocalDate | null
  newPlannedStartOn?: LocalDate | null
}

export interface TaskDetailDto extends TaskListItemDto {
  children: TaskListItemDto[]
  history: TaskHistoryEventDto[]
}

export interface TodaySnapshotDto {
  localDate: LocalDate
  reviewCardState: 'VISIBLE' | 'DISMISSED' | 'FINISHED'
  overdue: TaskListItemDto[]
  dueToday: TaskListItemDto[]
  completedToday: TaskListItemDto[]
  counts: { overdue: number; dueToday: number; completedToday: number }
}

export interface MorningReviewSnapshotDto {
  localDate: LocalDate
  yesterday: LocalDate
  yesterdayOutcomes: Array<{
    task: TaskListItemDto
    outcome: 'COMPLETED' | 'CANCELLED'
    occurredAtUtc: UtcTimestamp
  }>
  overdue: TaskListItemDto[]
  unscheduled: TaskListItemDto[]
  dueToday: TaskListItemDto[]
}

export interface GoalCategoryDto {
  id: EntityId
  name: string
  version?: number
}

export type GoalPeriodDto =
  | { kind: 'NONE'; startOn: null; endOn: null }
  | { kind: 'MONTH' | 'QUARTER' | 'YEAR' | 'CUSTOM'; startOn: LocalDate; endOn: LocalDate }

export interface GoalDto {
  id: EntityId
  version: number
  name: string
  description: string | null
  category: GoalCategoryDto | null
  priority: GoalPriority | null
  period: GoalPeriodDto
  status: GoalStatus
  projectCount: number
  activeProjectCount: number
  createdAtUtc: UtcTimestamp
  updatedAtUtc: UtcTimestamp
}

export interface ProjectDto {
  id: EntityId
  version: number
  name: string
  description: string | null
  goal: EntityRefDto | null
  status: ProjectStatus
  tasks: TaskListItemDto[]
  pendingTaskCount: number
  pendingExecutableCount: number
  enabledSeriesCount: number
  hasNextAction: boolean
  createdAtUtc: UtcTimestamp
  updatedAtUtc: UtcTimestamp
}

export interface RecurrencePatternDto {
  kind: RecurrenceKind
  weekdays: number[]
  monthlyDay: number | null
}

export interface RecurrenceSeriesDto {
  id: EntityId
  version: number
  enabled: boolean
  title: string
  notes: string | null
  project: EntityRefDto | null
  important: boolean
  urgent: boolean
  startOn: LocalDate
  endOn: LocalDate | null
  pattern: RecurrencePatternDto
  effectiveFromOn: LocalDate
  createdOn: LocalDate
}

export interface ProjectedOccurrenceDto {
  kind: 'PROJECTED_OCCURRENCE'
  occurrenceKey: string
  seriesId: EntityId
  expectedSeriesRowVersion: number
  appliedRuleVersionId: EntityId
  originalOccurrenceOn: LocalDate
  plannedOn: LocalDate
  title: string
  notes: string | null
  project: EntityRefDto | null
  important: boolean
  urgent: boolean
}

export type CalendarItemDto =
  | { kind: 'TASK'; task: TaskListItemDto }
  | ProjectedOccurrenceDto

export interface CalendarRangeDto {
  startOn: LocalDate
  endOn: LocalDate
  days: Array<{ date: LocalDate; items: CalendarItemDto[] }>
}

/**
 * A read-only event imported from an external calendar.
 *
 * All-day values use YYYY-MM-DD with an exclusive `end`. Timed UTC/offset
 * values are normalized to UTC ISO strings; floating/TZID values preserve
 * their local wall-clock representation and expose the source time zone.
 */
export interface ExternalEventDto {
  kind: 'EXTERNAL_EVENT'
  id: string
  source: ExternalCalendarSource
  title: string
  start: string
  end: string
  allDay: boolean
  location: string | null
  timeZone: string | null
}

export interface ExternalCalendarRangeDto {
  startOn: LocalDate
  endOn: LocalDate
  items: ExternalEventDto[]
}

export interface ExternalCalendarStatusDto {
  source: ExternalCalendarSource
  connected: boolean
  syncing: boolean
  serverHost: string | null
  accountHint: string | null
  lastAttemptAtUtc: UtcTimestamp | null
  lastSuccessAtUtc: UtcTimestamp | null
  lastErrorCode: 'AUTH_FAILED' | 'NETWORK' | 'PROTOCOL' | 'STORAGE' | null
  cachedEventCount: number
  cachedRangeStartOn: LocalDate | null
  cachedRangeEndOn: LocalDate | null
}

export interface ExternalCalendarSyncResultDto {
  status: ExternalCalendarStatusDto
  receivedEventCount: number
}

export interface QuadrantSnapshotDto {
  localDate: LocalDate
  quadrants: Record<'Q1' | 'Q2' | 'Q3' | 'Q4', TaskListItemDto[]>
}

export interface BootstrapDto {
  localDate: LocalDate
  appVersion: string
  dataEpoch: string
  revision: number
  schemaVersion: number
}

export interface ConfirmationDetailDto {
  confirmationToken: string
  kind:
    | 'PARENT_STATUS_WITH_OPEN_CHILDREN'
    | 'MOVE_PARENT_AND_CHILDREN_TO_PROJECT'
    | 'ATTACH_TASK_TO_PARENT_AND_MOVE_PROJECT'
    | 'GOAL_CLOSE_WITH_ACTIVE_PROJECTS'
  title: string
  description: string
  facts: Record<string, number>
  expiresAtUtc: UtcTimestamp
}

export interface BackupCountsDto {
  goals: number
  goalCategories: number
  projects: number
  tasks: number
  taskStatusEvents: number
  taskScheduleEvents: number
  recurrenceSeries: number
  settings: number
}

export interface BackupInspectionDto {
  inspectionToken: string
  confirmationToken: string
  displayName: string
  createdAtUtc: UtcTimestamp
  applicationVersion: string
  schemaVersion: number
  counts: BackupCountsDto
  canonicalDomainDigest: string
}

export interface SafetyBackupDto {
  id: string
  displayName: string
  createdAtUtc: UtcTimestamp
  sizeBytes: number
  schemaVersion: number
}

export interface BackupProgressDto {
  operationId: string
  stage: 'PREPARING' | 'SNAPSHOTTING' | 'VERIFYING' | 'SAFETY_BACKUP' | 'BUILDING_CANDIDATE' | 'SWITCHING' | 'REOPENING' | 'DONE'
  percent: number
  message: string
}

export interface BackupExportResultDto {
  cancelled?: boolean
  displayName?: string
  sha256?: string
  counts?: BackupCountsDto
}

export interface BackupRestoreResultDto {
  operationId: string
  safetyBackup: SafetyBackupDto
  restoredCounts: BackupCountsDto
}
