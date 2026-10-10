import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  ApplyProjectedOccurrenceInput,
  ChangeGoalStatusInput,
  ChangeProjectStatusInput,
  ChangeTaskParentInput,
  ChangeTaskStatusInput,
  CreateChildTaskInput,
  CreateGoalInput,
  CreateNextStepInput,
  CreateParentAndAttachInput,
  CreateProjectInput,
  CreateRecurrenceSeriesInput,
  CreateTaskInput,
  GoalListQuery,
  MoveTaskTreeInput,
  SetRecurrenceEnabledInput,
  SetTaskScheduleInput,
  TaskListQuery,
  UpdateGoalInput,
  UpdateProjectInput,
  UpdateRecurrenceFromDateInput,
  UpdateTaskContentInput
} from '@shared/inputs'
import type {
  BootstrapDto,
  CalendarItemDto,
  CalendarRangeDto,
  ChangeNoticeDto,
  GoalCategoryDto,
  GoalDto,
  GoalPeriodDto,
  GoalPriority,
  GoalStatus,
  MorningReviewSnapshotDto,
  MutationEnvelope,
  ProjectDto,
  ProjectedOccurrenceDto,
  ProjectStatus,
  QuadrantSnapshotDto,
  RecurrencePatternDto,
  RecurrenceSeriesDto,
  TaskDetailDto,
  TaskHistoryEventDto,
  TaskListItemDto,
  TaskStatus,
  TodaySnapshotDto
} from '@shared/types'
import {
  DomainError,
  invariant,
  normalizeOptionalText,
  requireNonBlank
} from '../domain/errors'
import { validateAndNormalizeGoalPeriod } from '../domain/goal-period'
import { type DateProvider, LocalDate, SystemDateProvider } from '../domain/local-date'
import {
  occursOn,
  patternFromColumns,
  validateRecurrencePattern,
  weekdayMask,
  type RecurrenceRule
} from '../domain/recurrence'
import { DatabaseManager } from './database-manager'
import { CURRENT_SCHEMA_VERSION } from './migrations'
import { mapTaskRow, TASK_SELECT, type TaskJoinedRow } from './row-mappers'

interface GoalRow {
  id: string
  name: string
  description: string | null
  category_id: string | null
  category_name: string | null
  priority: GoalPriority | null
  period_kind: GoalPeriodDto['kind']
  period_start_on: string | null
  period_end_on: string | null
  status: GoalStatus
  created_at_utc: number
  updated_at_utc: number
  row_version: number
  project_count: number
  active_project_count: number
}

interface ProjectRow {
  id: string
  goal_id: string | null
  goal_name: string | null
  name: string
  description: string | null
  status: ProjectStatus
  created_at_utc: number
  updated_at_utc: number
  row_version: number
  pending_task_count: number
  pending_executable_count: number
  enabled_series_count: number
}

interface TaskCoreRow {
  id: string
  title: string
  notes: string | null
  planned_on: string | null
  status: TaskStatus
  project_id: string | null
  parent_task_id: string | null
  is_important: number
  is_urgent: number
  recurrence_series_id: string | null
  applied_rule_version_id: string | null
  original_occurrence_on: string | null
  is_recurrence_exception: number
  row_version: number
}

interface SeriesRow {
  id: string
  created_on: string
  materialized_through_on: string | null
  row_version: number
  created_at_utc: number
  updated_at_utc: number
}

interface RuleVersionRow {
  id: string
  series_id: string
  effective_from_on: string
  effective_to_on_exclusive: string | null
  timeline_active: number
  enabled: number
  title: string
  notes: string | null
  project_id: string | null
  is_important: number
  is_urgent: number
  rule_kind: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  rule_start_on: string
  rule_end_on: string | null
  weekday_mask: number
  monthly_day: number | null
  created_at_utc: number
  retired_at_utc: number | null
}

interface ConfirmationRecord {
  kind:
    | 'PARENT_STATUS_WITH_OPEN_CHILDREN'
    | 'MOVE_PARENT_AND_CHILDREN_TO_PROJECT'
    | 'ATTACH_TASK_TO_PARENT_AND_MOVE_PROJECT'
    | 'GOAL_CLOSE_WITH_ACTIVE_PROJECTS'
  entityId: string
  expectedVersion: number
  target: string
  facts: Record<string, number>
  expiresAtUtcMs: number
}

const GOAL_SELECT = `
SELECT goal.*, category.name AS category_name,
  (SELECT count(*) FROM projects project WHERE project.goal_id = goal.id) AS project_count,
  (SELECT count(*) FROM projects project WHERE project.goal_id = goal.id AND project.status = 'ACTIVE') AS active_project_count
FROM goals goal
LEFT JOIN goal_categories category ON category.id = goal.category_id
`

const PROJECT_SELECT = `
SELECT project.*, goal.name AS goal_name,
  (SELECT count(*) FROM tasks task WHERE task.project_id = project.id AND task.status = 'TODO') AS pending_task_count,
  (SELECT count(*) FROM tasks task WHERE task.project_id = project.id AND task.status = 'TODO'
    AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = task.id)) AS pending_executable_count,
  (SELECT count(DISTINCT version.series_id) FROM recurrence_rule_versions version
    WHERE version.project_id = project.id AND version.timeline_active = 1 AND version.enabled = 1
      AND (version.effective_to_on_exclusive IS NULL OR version.effective_to_on_exclusive > @today)) AS enabled_series_count
FROM projects project
LEFT JOIN goals goal ON goal.id = project.goal_id
`

export class DomainStore {
  private readonly confirmations = new Map<string, ConfirmationRecord>()

  constructor(
    readonly databaseManager: DatabaseManager,
    readonly dates: DateProvider = new SystemDateProvider()
  ) {}

  getBootstrap(appVersion: string): BootstrapDto {
    const today = this.today()
    const metadata = this.databaseManager.metadata
    return {
      localDate: today,
      appVersion,
      dataEpoch: metadata.dataEpoch,
      revision: metadata.revision,
      schemaVersion: CURRENT_SCHEMA_VERSION
    }
  }

  reconcile(): MutationEnvelope<{ localDate: string }> {
    const today = this.today()
    let revision = this.databaseManager.metadata.revision
    let changed = false
    this.databaseManager.immediate((database) => {
      const meta = database.prepare('SELECT last_reconciled_on FROM database_meta WHERE id = 1').get() as {
        last_reconciled_on: string | null
      }
      changed = this.materializeAllThrough(database, today)
      const now = this.now()
      const expired = database
        .prepare(`SELECT id, status FROM goals WHERE status = 'ACTIVE' AND period_end_on IS NOT NULL AND period_end_on < ?`)
        .all(today) as Array<{ id: string; status: GoalStatus }>
      const updateGoal = database.prepare(
        `UPDATE goals SET status = 'REVIEW_REQUIRED', updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
      )
      const addHistory = database.prepare(
        `INSERT INTO goal_status_history(id, goal_id, old_status, new_status, changed_on, changed_at_utc) VALUES (?, ?, ?, 'REVIEW_REQUIRED', ?, ?)`
      )
      for (const goal of expired) {
        updateGoal.run(now, goal.id)
        addHistory.run(randomUUID(), goal.id, goal.status, today, now)
        changed = true
      }
      if (meta.last_reconciled_on !== today) {
        database.prepare('UPDATE database_meta SET last_reconciled_on = ? WHERE id = 1').run(today)
        changed = true
      }
      if (changed) revision = this.databaseManager.bumpRevision(database)
    })
    return {
      value: { localDate: today },
      change: this.notice(revision, changed ? 'maintenance-sweep' : 'maintenance-sweep-noop', changed ? ['ALL'] : [])
    }
  }

  getTodaySnapshot(): TodaySnapshotDto {
    this.ensureReconciled()
    const today = this.today()
    const overdue = this.taskRows(`task.status = 'TODO' AND task.planned_on < ? AND ${leafPredicate('task')}`, [today]).map((row) =>
      mapTaskRow(row, today)
    )
    const dueToday = this.taskRows(`task.status = 'TODO' AND task.planned_on = ? AND ${leafPredicate('task')}`, [today]).map((row) =>
      mapTaskRow(row, today)
    )
    const completedToday = this.taskRows(`task.status = 'DONE' AND task.completed_on = ? AND ${leafPredicate('task')}`, [today]).map(
      (row) => mapTaskRow(row, today)
    )
    const review = this.databaseManager.connection
      .prepare('SELECT dismissed_at_utc, finished_at_utc FROM daily_review_state WHERE review_on = ?')
      .get(today) as { dismissed_at_utc: number | null; finished_at_utc: number | null } | undefined
    const reviewCardState = review?.finished_at_utc != null ? 'FINISHED' : review?.dismissed_at_utc != null ? 'DISMISSED' : 'VISIBLE'
    return {
      localDate: today,
      reviewCardState,
      overdue,
      dueToday,
      completedToday,
      counts: { overdue: overdue.length, dueToday: dueToday.length, completedToday: completedToday.length }
    }
  }

  getMorningReviewSnapshot(): MorningReviewSnapshotDto {
    this.ensureReconciled()
    const today = this.today()
    const yesterday = LocalDate.parse(today).addDays(-1).toString()
    const outcomeRows = this.databaseManager.connection
      .prepare(
        `WITH last_events AS (
          SELECT task_id, max(event_seq) AS event_seq
          FROM task_status_history WHERE changed_on = ? GROUP BY task_id
        )
        SELECT history.task_id, history.new_status, history.changed_at_utc
        FROM task_status_history history
        JOIN last_events last ON last.event_seq = history.event_seq
        WHERE history.new_status IN ('DONE','CANCELLED')
        ORDER BY history.event_seq`
      )
      .all(yesterday) as Array<{ task_id: string; new_status: 'DONE' | 'CANCELLED'; changed_at_utc: number }>
    const yesterdayOutcomes = outcomeRows.flatMap((outcome) => {
      const row = this.taskRowById(outcome.task_id)
      return row === undefined
        ? []
        : [
            {
              task: mapTaskRow(row, today),
              outcome: outcome.new_status === 'DONE' ? ('COMPLETED' as const) : ('CANCELLED' as const),
              occurredAtUtc: new Date(outcome.changed_at_utc).toISOString()
            }
          ]
    })
    return {
      localDate: today,
      yesterday,
      yesterdayOutcomes,
      overdue: this.getTodaySnapshot().overdue,
      unscheduled: this.getPlanningSnapshot(),
      dueToday: this.getTodaySnapshot().dueToday
    }
  }

  dismissReviewCard(expectedLocalDate: string): MutationEnvelope<void> {
    return this.setReviewState('dismissed_at_utc', expectedLocalDate, 'review-dismissed')
  }

  startReview(expectedLocalDate: string): MutationEnvelope<void> {
    return this.setReviewState('started_at_utc', expectedLocalDate, 'review-started')
  }

  finishReview(expectedLocalDate: string): MutationEnvelope<void> {
    return this.setReviewState('finished_at_utc', expectedLocalDate, 'review-finished')
  }

  getPlanningSnapshot(): TaskListItemDto[] {
    const today = this.today()
    return this.taskRows(`task.status = 'TODO' AND task.planned_on IS NULL AND ${leafPredicate('task')}`, []).map((row) =>
      mapTaskRow(row, today)
    )
  }

  listTasks(query: TaskListQuery = {}): { items: TaskListItemDto[]; total: number } {
    const clauses: string[] = []
    const parameters: unknown[] = []
    if (query.goalId !== undefined) {
      clauses.push(query.goalId === null ? 'task.goal_id IS NULL' : 'task.goal_id = ?')
      if (query.goalId !== null) parameters.push(query.goalId)
    }
    if (query.status !== undefined && query.status !== 'ALL') {
      clauses.push('task.status = ?')
      parameters.push(query.status)
    }
    if ('projectId' in query) {
      clauses.push(query.projectId === null ? 'task.project_id IS NULL' : 'task.project_id = ?')
      if (query.projectId !== null) parameters.push(query.projectId)
    }
    if ('parentId' in query) {
      clauses.push(query.parentId === null ? 'task.parent_task_id IS NULL' : 'task.parent_task_id = ?')
      if (query.parentId !== null) parameters.push(query.parentId)
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      clauses.push(`(task.title LIKE ? ESCAPE '\\' OR coalesce(task.notes, '') LIKE ? ESCAPE '\\')`)
      const term = `%${escapeLike(query.search.trim())}%`
      parameters.push(term, term)
    }
    const where = clauses.length === 0 ? '1 = 1' : clauses.join(' AND ')
    const count = this.databaseManager.connection.prepare(`SELECT count(*) AS count FROM tasks task WHERE ${where}`).get(...parameters) as {
      count: number
    }
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 100
    const rows = this.databaseManager.connection
      .prepare(`${TASK_SELECT} WHERE ${where} ORDER BY task.created_at_utc DESC, task.id LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, (page - 1) * pageSize) as TaskJoinedRow[]
    const today = this.today()
    return { items: rows.map((row) => mapTaskRow(row, today)), total: count.count }
  }

  getTaskDetail(id: string): TaskDetailDto {
    const row = this.taskRowById(id)
    if (row === undefined) throw new DomainError('NOT_FOUND', '任务不存在')
    const today = this.today()
    const children = this.taskRows('task.parent_task_id = ?', [id]).map((child) => mapTaskRow(child, today))
    const statusRows = this.databaseManager.connection
      .prepare(
        `SELECT event_seq, id, changed_on, changed_at_utc, old_status AS old_value, new_status AS new_value
         FROM task_status_history WHERE task_id = ?`
      )
      .all(id) as Array<{ event_seq: number; id: string; changed_on: string; changed_at_utc: number; old_value: string; new_value: string }>
    const scheduleRows = this.databaseManager.connection
      .prepare(
        `SELECT event_seq, id, changed_on, changed_at_utc, old_planned_on AS old_value, new_planned_on AS new_value
         FROM task_schedule_history WHERE task_id = ?`
      )
      .all(id) as Array<{
      event_seq: number
      id: string
      changed_on: string
      changed_at_utc: number
      old_value: string | null
      new_value: string | null
    }>
    const history: TaskHistoryEventDto[] = [
      ...statusRows.map((event) => ({
        id: event.id,
        eventSeq: event.event_seq,
        kind: 'STATUS' as const,
        changedOn: event.changed_on,
        changedAtUtc: new Date(event.changed_at_utc).toISOString(),
        oldValue: event.old_value,
        newValue: event.new_value
      })),
      ...scheduleRows.map((event) => ({
        id: event.id,
        eventSeq: event.event_seq,
        kind: 'SCHEDULE' as const,
        changedOn: event.changed_on,
        changedAtUtc: new Date(event.changed_at_utc).toISOString(),
        oldValue: event.old_value,
        newValue: event.new_value
      }))
    ].sort((a, b) => a.changedAtUtc.localeCompare(b.changedAtUtc) || a.eventSeq - b.eventSeq)
    return { ...mapTaskRow(row, today), children, history }
  }

  createTask(input: CreateTaskInput): MutationEnvelope<TaskDetailDto> {
    const today = this.today()
    const now = this.now()
    const id = randomUUID()
    const title = requireNonBlank(input.title, '任务标题')
    const notes = normalizeOptionalText(input.notes)
    const plannedOn = input.plannedOn == null ? null : this.date(input.plannedOn, 'plannedOn')
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-created', (database) => {
      let projectId = input.projectId ?? null
      if (input.parentTaskId != null) {
        const parent = this.taskCore(input.parentTaskId, database)
        invariant(parent.parent_task_id === null, 'TASK_DEPTH_EXCEEDED', '子工作不能继续创建下一级')
        invariant(parent.recurrence_series_id === null, 'RECURRENCE_RELATION_FORBIDDEN', '重复实例不能成为父工作')
        invariant(parent.status === 'TODO', 'PARENT_NOT_ACTIVE', '已结束的父工作不能新增待办子工作')
        projectId = parent.project_id
      }
      this.assertProjectCanReceiveTodo(projectId, database)
      this.assertGoalExists(input.goalId ?? null, database)
      database
        .prepare(
          `INSERT INTO tasks(
            id, title, notes, planned_on, status, project_id, parent_task_id, goal_id,
            is_important, is_urgent, completed_on, cancelled_on,
            recurrence_series_id, applied_rule_version_id, original_occurrence_on, is_recurrence_exception,
            created_on, created_at_utc, updated_at_utc, row_version
          ) VALUES (?, ?, ?, ?, 'TODO', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?, 1)`
        )
        .run(id, title, notes, plannedOn, projectId, input.parentTaskId ?? null, input.goalId ?? null, bool(input.important), bool(input.urgent), today, now, now)
      return this.getTaskDetail(id)
    })
  }

  createChildTask(input: CreateChildTaskInput): MutationEnvelope<TaskDetailDto> {
    const parent = this.taskCore(input.parentId)
    this.assertVersion(parent.row_version, input.parentExpectedVersion)
    return this.createTask({
      goalId: input.goalId,
      title: input.title,
      notes: input.notes,
      plannedOn: input.plannedOn,
      parentTaskId: input.parentId,
      important: input.important,
      urgent: input.urgent
    })
  }

  updateTaskContent(input: UpdateTaskContentInput): MutationEnvelope<TaskDetailDto> {
    const now = this.now()
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-content-updated', (database) => {
      const task = this.taskCore(input.id, database)
      this.assertVersion(task.row_version, input.expectedVersion)
      const title = input.title === undefined ? task.title : requireNonBlank(input.title, '任务标题')
      if (input.goalId !== undefined) this.assertGoalExists(input.goalId, database)
      const notes = input.notes === undefined ? task.notes : normalizeOptionalText(input.notes)
      const important = input.important === undefined ? task.is_important : bool(input.important)
      const urgent = input.urgent === undefined ? task.is_urgent : bool(input.urgent)
      database
        .prepare(
          `UPDATE tasks SET title = ?, notes = ?, is_important = ?, is_urgent = ?,
            is_recurrence_exception = CASE WHEN recurrence_series_id IS NULL THEN 0 ELSE 1 END,
            updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(title, notes, important, urgent, now, task.id)
      if (input.goalId !== undefined) database.prepare('UPDATE tasks SET goal_id = ? WHERE id = ?').run(input.goalId, task.id)
      return this.getTaskDetail(task.id)
    })
  }

  setTaskSchedule(input: SetTaskScheduleInput): MutationEnvelope<TaskDetailDto> {
    const today = this.today()
    const now = this.now()
    const plannedOn = input.plannedOn === null ? null : this.date(input.plannedOn, 'plannedOn')
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-scheduled', (database) => {
      const task = this.taskCore(input.id, database)
      this.assertVersion(task.row_version, input.expectedVersion)
      database
        .prepare(
          `UPDATE tasks SET planned_on = ?,
            is_recurrence_exception = CASE WHEN recurrence_series_id IS NULL THEN 0 ELSE 1 END,
            updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(plannedOn, now, task.id)
      if (task.planned_on !== plannedOn) {
        database
          .prepare(
            `INSERT INTO task_schedule_history(id, task_id, old_planned_on, new_planned_on, changed_on, changed_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), task.id, task.planned_on, plannedOn, today, now)
      }
      return this.getTaskDetail(task.id)
    })
  }

  changeTaskStatus(input: ChangeTaskStatusInput): MutationEnvelope<TaskDetailDto> {
    const today = this.today()
    const now = this.now()
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-status-changed', (database) => {
      const task = this.taskCore(input.id, database)
      this.assertVersion(task.row_version, input.expectedVersion)
      const pendingChildren = this.pendingChildCount(task.id, database)
      if ((input.status === 'DONE' || input.status === 'CANCELLED') && pendingChildren > 0) {
        this.requireConfirmation(
          input.confirmationToken,
          'PARENT_STATUS_WITH_OPEN_CHILDREN',
          task.id,
          input.expectedVersion,
          input.status,
          { pendingChildCount: pendingChildren },
          '父工作仍有待办子工作，确认后不会级联修改子工作'
        )
      }
      if (input.status === 'TODO') this.assertProjectCanReceiveTodo(task.project_id, database)
      const completedOn = input.status === 'DONE' ? today : null
      const cancelledOn = input.status === 'CANCELLED' ? today : null
      database
        .prepare(
          `UPDATE tasks SET status = ?, completed_on = ?, cancelled_on = ?,
            is_recurrence_exception = CASE WHEN recurrence_series_id IS NULL THEN 0 ELSE 1 END,
            updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(input.status, completedOn, cancelledOn, now, task.id)
      if (task.status !== input.status) {
        database
          .prepare(
            `INSERT INTO task_status_history(id, task_id, old_status, new_status, changed_on, changed_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), task.id, task.status, input.status, today, now)
      }
      return this.getTaskDetail(task.id)
    })
  }

  changeTaskParent(input: ChangeTaskParentInput): MutationEnvelope<TaskDetailDto> {
    const now = this.now()
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-parent-changed', (database) => {
      const task = this.taskCore(input.id, database)
      this.assertVersion(task.row_version, input.expectedVersion)
      invariant(task.recurrence_series_id === null, 'RECURRENCE_RELATION_FORBIDDEN', '重复实例不能成为子工作')
      invariant(this.childCount(task.id, database) === 0, 'TASK_DEPTH_EXCEEDED', '已有子工作的任务不能再成为子工作')
      let projectId = task.project_id
      if (input.parentId !== null) {
        const parent = this.taskCore(input.parentId, database)
        invariant(parent.id !== task.id, 'TASK_DEPTH_EXCEEDED', '任务不能以自己为父工作')
        invariant(parent.parent_task_id === null, 'TASK_DEPTH_EXCEEDED', '子工作不能继续创建下一级')
        invariant(parent.recurrence_series_id === null, 'RECURRENCE_RELATION_FORBIDDEN', '重复实例不能成为父工作')
        if (task.status === 'TODO') invariant(parent.status === 'TODO', 'PARENT_NOT_ACTIVE', '已结束的父工作不能接收待办子工作')
        if (parent.project_id !== task.project_id) {
          this.requireConfirmation(
            input.confirmationToken,
            'ATTACH_TASK_TO_PARENT_AND_MOVE_PROJECT',
            task.id,
            input.expectedVersion,
            `${parent.id}:${parent.project_id ?? '@none'}`,
            { projectChanged: 1 },
            '挂接后，该任务将迁入父工作所属项目；日期、状态、历史和四象限属性保持不变'
          )
        }
        projectId = parent.project_id
        if (task.status === 'TODO') this.assertProjectCanReceiveTodo(projectId, database)
      }
      database
        .prepare('UPDATE tasks SET parent_task_id = ?, project_id = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?')
        .run(input.parentId, projectId, now, task.id)
      return this.getTaskDetail(task.id)
    })
  }

  createParentAndAttach(input: CreateParentAndAttachInput): MutationEnvelope<TaskDetailDto> {
    const today = this.today()
    const now = this.now()
    const parentId = randomUUID()
    const title = requireNonBlank(input.title, '父工作标题')
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-parent-created-and-attached', (database) => {
      const child = this.taskCore(input.childId, database)
      this.assertVersion(child.row_version, input.childExpectedVersion)
      invariant(child.recurrence_series_id === null, 'RECURRENCE_RELATION_FORBIDDEN', '重复实例不能成为子工作')
      invariant(this.childCount(child.id, database) === 0, 'TASK_DEPTH_EXCEEDED', '已有子工作的任务不能再成为子工作')
      this.assertProjectCanReceiveTodo(child.project_id, database)
      database
        .prepare(
          `INSERT INTO tasks(
            id, title, notes, planned_on, status, project_id, parent_task_id,
            is_important, is_urgent, completed_on, cancelled_on,
            recurrence_series_id, applied_rule_version_id, original_occurrence_on, is_recurrence_exception,
            created_on, created_at_utc, updated_at_utc, row_version
          ) VALUES (?, ?, NULL, NULL, 'TODO', ?, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?, 1)`
        )
        .run(parentId, title, child.project_id, today, now, now)
      database
        .prepare('UPDATE tasks SET parent_task_id = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?')
        .run(parentId, now, child.id)
      return this.getTaskDetail(child.id)
    })
  }

  moveTaskTree(input: MoveTaskTreeInput): MutationEnvelope<TaskDetailDto> {
    const now = this.now()
    return this.mutate(['TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'task-tree-moved', (database) => {
      const task = this.taskCore(input.id, database)
      this.assertVersion(task.row_version, input.expectedVersion)
      invariant(task.parent_task_id === null, 'PARENT_PROJECT_MISMATCH', '子工作不能在保持父子关系时单独迁移项目')
      const children = this.childCount(task.id, database)
      if (children > 0 && task.project_id !== input.projectId) {
        this.requireConfirmation(
          input.confirmationToken,
          'MOVE_PARENT_AND_CHILDREN_TO_PROJECT',
          task.id,
          input.expectedVersion,
          input.projectId ?? '@none',
          { childCount: children },
          '将同时迁移父工作和全部直接子工作'
        )
      }
      const todoCount = database
        .prepare(`SELECT count(*) AS count FROM tasks WHERE (id = ? OR parent_task_id = ?) AND status = 'TODO'`)
        .get(task.id, task.id) as { count: number }
      if (todoCount.count > 0) this.assertProjectCanReceiveTodo(input.projectId, database)
      database
        .prepare(
          `UPDATE tasks SET project_id = ?,
             is_recurrence_exception = CASE WHEN recurrence_series_id IS NULL THEN 0 ELSE 1 END,
             updated_at_utc = ?, row_version = row_version + 1
           WHERE id = ? OR parent_task_id = ?`
        )
        .run(input.projectId, now, task.id, task.id)
      return this.getTaskDetail(task.id)
    })
  }

  createNextStep(input: CreateNextStepInput): MutationEnvelope<TaskDetailDto> {
    const source = this.taskCore(input.sourceTaskId)
    invariant(source.status === 'DONE', 'VALIDATION_FAILED', '只能从已完成任务创建下一步')
    let parentTaskId: string | null = null
    if (source.parent_task_id !== null) {
      const parent = this.taskCore(source.parent_task_id)
      if (parent.status === 'TODO') parentTaskId = parent.id
    }
    return this.createTask({
      title: input.title,
      notes: input.notes,
      plannedOn: input.plannedOn,
      important: input.important,
      urgent: input.urgent,
      projectId: source.project_id,
      goalId: input.goalId,
      parentTaskId
    })
  }

  getQuadrantSnapshot(): QuadrantSnapshotDto {
    const today = this.today()
    const quadrants: QuadrantSnapshotDto['quadrants'] = { Q1: [], Q2: [], Q3: [], Q4: [] }
    const rows = this.taskRows(`task.status = 'TODO' AND task.planned_on IS NOT NULL AND ${leafPredicate('task')}`, [])
    for (const row of rows) {
      const key = row.is_important === 1 ? (row.is_urgent === 1 ? 'Q1' : 'Q2') : row.is_urgent === 1 ? 'Q3' : 'Q4'
      quadrants[key].push(mapTaskRow(row, today))
    }
    return { localDate: today, quadrants }
  }

  getCalendarRange(startOnValue: string, endOnValue: string, includeCancelled = false): CalendarRangeDto {
    this.ensureReconciled()
    const start = LocalDate.parse(this.date(startOnValue, 'startOn'))
    const end = LocalDate.parse(this.date(endOnValue, 'endOn'))
    invariant(!start.isAfter(end), 'VALIDATION_FAILED', '日历开始日不能晚于结束日')
    const today = this.today()
    const status = includeCancelled ? '' : `AND task.status <> 'CANCELLED'`
    const realRows = this.taskRows(
      `task.planned_on BETWEEN ? AND ? AND ${leafPredicate('task')} ${status}`,
      [start.toString(), end.toString()]
    )
    const byDate = new Map<string, CalendarItemDto[]>()
    for (let cursor = start; !cursor.isAfter(end); cursor = cursor.addDays(1)) byDate.set(cursor.toString(), [])
    for (const row of realRows) {
      if (row.planned_on !== null) byDate.get(row.planned_on)?.push({ kind: 'TASK', task: mapTaskRow(row, today) })
    }
    const futureStart = start.isAfter(LocalDate.parse(today)) ? start : LocalDate.parse(today).addDays(1)
    if (!futureStart.isAfter(end)) {
      for (const projection of this.projectOccurrences(futureStart.toString(), end.toString())) {
        byDate.get(projection.plannedOn)?.push(projection)
      }
    }
    return {
      startOn: start.toString(),
      endOn: end.toString(),
      days: [...byDate.entries()].map(([date, items]) => ({ date, items }))
    }
  }

  listGoalCategories(): GoalCategoryDto[] {
    return (
      this.databaseManager.connection
        .prepare('SELECT id, name FROM goal_categories ORDER BY normalized_name, id')
        .all() as Array<{ id: string; name: string }>
    ).map((row) => ({ id: row.id, name: row.name }))
  }

  createGoalCategory(nameValue: string): MutationEnvelope<GoalCategoryDto> {
    const name = requireNonBlank(nameValue, '分类名称')
    const normalized = normalizeCategory(name)
    const id = randomUUID()
    const now = this.now()
    return this.mutate(['GOALS'], 'goal-category-created', (database) => {
      database
        .prepare('INSERT INTO goal_categories(id, name, normalized_name, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, normalized, now, now)
      return { id, name }
    })
  }

  renameGoalCategory(id: string, nameValue: string): MutationEnvelope<GoalCategoryDto> {
    const name = requireNonBlank(nameValue, '分类名称')
    const normalized = normalizeCategory(name)
    const now = this.now()
    return this.mutate(['GOALS'], 'goal-category-renamed', (database) => {
      const result = database
        .prepare('UPDATE goal_categories SET name = ?, normalized_name = ?, updated_at_utc = ? WHERE id = ?')
        .run(name, normalized, now, id)
      if (result.changes === 0) throw new DomainError('NOT_FOUND', '目标分类不存在')
      return { id, name }
    })
  }

  removeGoalCategory(id: string): MutationEnvelope<void> {
    return this.mutate(['GOALS'], 'goal-category-removed', (database) => {
      const references = database.prepare('SELECT count(*) AS count FROM goals WHERE category_id = ?').get(id) as { count: number }
      invariant(references.count === 0, 'VALIDATION_FAILED', '只能删除未被目标引用的分类', { referenceCount: references.count })
      const result = database.prepare('DELETE FROM goal_categories WHERE id = ?').run(id)
      if (result.changes === 0) throw new DomainError('NOT_FOUND', '目标分类不存在')
    })
  }

  listGoals(query: GoalListQuery = {}): GoalDto[] {
    const clauses: string[] = []
    const parameters: unknown[] = []
    if (query.status !== undefined && query.status !== 'ALL') {
      clauses.push('goal.status = ?')
      parameters.push(query.status)
    }
    if (query.categoryId !== undefined) {
      clauses.push(query.categoryId === null ? 'goal.category_id IS NULL' : 'goal.category_id = ?')
      if (query.categoryId !== null) parameters.push(query.categoryId)
    }
    if (query.priority !== undefined && query.priority !== 'ALL') {
      clauses.push(query.priority === 'UNSET' ? 'goal.priority IS NULL' : 'goal.priority = ?')
      if (query.priority !== 'UNSET') parameters.push(query.priority)
    }
    const where = clauses.length === 0 ? '1 = 1' : clauses.join(' AND ')
    const rows = this.databaseManager.connection
      .prepare(
        `${GOAL_SELECT} WHERE ${where}
         ORDER BY CASE goal.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
           goal.created_at_utc DESC, goal.id`
      )
      .all(...parameters) as GoalRow[]
    return rows.map(mapGoal)
  }

  getGoalDetail(id: string): GoalDto {
    const row = this.databaseManager.connection.prepare(`${GOAL_SELECT} WHERE goal.id = ?`).get(id) as GoalRow | undefined
    if (row === undefined) throw new DomainError('NOT_FOUND', '目标不存在')
    return mapGoal(row)
  }

  createGoal(input: CreateGoalInput): MutationEnvelope<GoalDto> {
    const id = randomUUID()
    const now = this.now()
    const period = validateAndNormalizeGoalPeriod(input.period)
    const status: GoalStatus = period.endOn !== null && period.endOn < this.today() ? 'REVIEW_REQUIRED' : 'ACTIVE'
    const name = requireNonBlank(input.name, '目标名称')
    const description = normalizeOptionalText(input.description)
    return this.mutate(['GOALS'], 'goal-created', (database) => {
      this.assertCategoryExists(input.categoryId ?? null, database)
      database
        .prepare(
          `INSERT INTO goals(id, name, description, category_id, priority, period_kind, period_start_on, period_end_on,
            status, created_at_utc, updated_at_utc, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          id,
          name,
          description,
          input.categoryId ?? null,
          input.priority ?? null,
          period.kind,
          period.startOn,
          period.endOn,
          status,
          now,
          now
        )
      return this.getGoalDetail(id)
    })
  }

  updateGoal(input: UpdateGoalInput): MutationEnvelope<GoalDto> {
    const today = this.today()
    const now = this.now()
    return this.mutate(['GOALS'], 'goal-updated', (database) => {
      const current = this.goalCore(input.id, database)
      this.assertVersion(current.row_version, input.expectedVersion)
      const name = input.name === undefined ? current.name : requireNonBlank(input.name, '目标名称')
      const description = input.description === undefined ? current.description : normalizeOptionalText(input.description)
      const categoryId = input.categoryId === undefined ? current.category_id : input.categoryId
      const priority = input.priority === undefined ? current.priority : input.priority
      const period =
        input.period === undefined
          ? rowPeriod(current.period_kind, current.period_start_on, current.period_end_on)
          : validateAndNormalizeGoalPeriod(input.period)
      this.assertCategoryExists(categoryId, database)
      const nextStatus = current.status === 'ACTIVE' && period.endOn !== null && period.endOn < today ? 'REVIEW_REQUIRED' : current.status
      database
        .prepare(
          `UPDATE goals SET name = ?, description = ?, category_id = ?, priority = ?, period_kind = ?, period_start_on = ?,
            period_end_on = ?, status = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(name, description, categoryId, priority, period.kind, period.startOn, period.endOn, nextStatus, now, current.id)
      if (nextStatus !== current.status) this.insertGoalHistory(database, current.id, current.status, nextStatus, today, now)
      return this.getGoalDetail(current.id)
    })
  }

  changeGoalStatus(input: ChangeGoalStatusInput): MutationEnvelope<GoalDto> {
    const today = this.today()
    const now = this.now()
    return this.mutate(['GOALS'], 'goal-status-changed', (database) => {
      const current = this.goalCore(input.id, database)
      this.assertVersion(current.row_version, input.expectedVersion)
      const activeProjects = database.prepare(`SELECT count(*) AS count FROM projects WHERE goal_id = ? AND status = 'ACTIVE'`).get(current.id) as {
        count: number
      }
      if ((input.status === 'COMPLETED' || input.status === 'ABANDONED') && activeProjects.count > 0) {
        this.requireConfirmation(
          input.confirmationToken,
          'GOAL_CLOSE_WITH_ACTIVE_PROJECTS',
          current.id,
          input.expectedVersion,
          input.status,
          { activeProjectCount: activeProjects.count },
          '目标仍有进行中项目，状态变更不会级联修改项目'
        )
      }
      let period = rowPeriod(current.period_kind, current.period_start_on, current.period_end_on)
      if (input.period !== undefined) period = validateAndNormalizeGoalPeriod(input.period)
      if (current.status === 'REVIEW_REQUIRED' && input.status === 'ACTIVE' && input.period === undefined) {
        throw new DomainError('GOAL_PERIOD_INVALID', '继续待复盘目标时必须设置新周期')
      }
      let status = input.status
      if (status === 'ACTIVE' && period.endOn !== null && period.endOn < today) status = 'REVIEW_REQUIRED'
      database
        .prepare(
          `UPDATE goals SET status = ?, period_kind = ?, period_start_on = ?, period_end_on = ?,
            updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(status, period.kind, period.startOn, period.endOn, now, current.id)
      if (status !== current.status) this.insertGoalHistory(database, current.id, current.status, status, today, now)
      return this.getGoalDetail(current.id)
    })
  }

  removeGoal(input: { id: string; expectedVersion: number }): MutationEnvelope<void> {
    const now = this.now()
    return this.mutate(['GOALS', 'PROJECTS', 'TASKS', 'TODAY', 'CALENDAR', 'QUADRANTS', 'PLANNING', 'REVIEW'], 'goal-removed', (database) => {
      const current = this.goalCore(input.id, database)
      this.assertVersion(current.row_version, input.expectedVersion)
      // Remove the relation only; linked tasks retain their content and history.
      database.prepare('UPDATE tasks SET goal_id = NULL, row_version = row_version + 1, updated_at_utc = ? WHERE goal_id = ?').run(now, current.id)
      database
        .prepare('UPDATE projects SET goal_id = NULL, updated_at_utc = ?, row_version = row_version + 1 WHERE goal_id = ?')
        .run(now, current.id)
      database.prepare('DELETE FROM goal_status_history WHERE goal_id = ?').run(current.id)
      database.prepare('DELETE FROM goals WHERE id = ?').run(current.id)
    })
  }

  listProjects(): ProjectDto[] {
    const today = this.today()
    const rows = this.databaseManager.connection
      .prepare(`${PROJECT_SELECT} ORDER BY CASE project.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, project.created_at_utc DESC, project.id`)
      .all({ today }) as ProjectRow[]
    return rows.map((row) => this.mapProject(row))
  }

  getProjectDetail(id: string): ProjectDto {
    const row = this.databaseManager.connection.prepare(`${PROJECT_SELECT} WHERE project.id = @id`).get({ id, today: this.today() }) as
      | ProjectRow
      | undefined
    if (row === undefined) throw new DomainError('NOT_FOUND', '项目不存在')
    return this.mapProject(row)
  }

  createProject(input: CreateProjectInput): MutationEnvelope<ProjectDto> {
    const id = randomUUID()
    const now = this.now()
    const name = requireNonBlank(input.name, '项目名称')
    const description = normalizeOptionalText(input.description)
    return this.mutate(['PROJECTS', 'GOALS'], 'project-created', (database) => {
      this.assertGoalExists(input.goalId ?? null, database)
      database
        .prepare(
          `INSERT INTO projects(id, goal_id, name, description, status, created_at_utc, updated_at_utc, row_version)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, 1)`
        )
        .run(id, input.goalId ?? null, name, description, now, now)
      return this.getProjectDetail(id)
    })
  }

  updateProject(input: UpdateProjectInput): MutationEnvelope<ProjectDto> {
    const now = this.now()
    return this.mutate(['PROJECTS', 'GOALS', 'TASKS'], 'project-updated', (database) => {
      const current = this.projectCore(input.id, database)
      this.assertVersion(current.row_version, input.expectedVersion)
      const name = input.name === undefined ? current.name : requireNonBlank(input.name, '项目名称')
      const description = input.description === undefined ? current.description : normalizeOptionalText(input.description)
      const goalId = input.goalId === undefined ? current.goal_id : input.goalId
      this.assertGoalExists(goalId, database)
      database
        .prepare(`UPDATE projects SET name = ?, description = ?, goal_id = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`)
        .run(name, description, goalId, now, current.id)
      return this.getProjectDetail(current.id)
    })
  }

  changeProjectStatus(input: ChangeProjectStatusInput): MutationEnvelope<ProjectDto> {
    const today = this.today()
    const now = this.now()
    return this.mutate(['PROJECTS', 'GOALS'], 'project-status-changed', (database) => {
      const current = this.projectCore(input.id, database)
      this.assertVersion(current.row_version, input.expectedVersion)
      if (input.status === 'COMPLETED') {
        const pending = database.prepare(`SELECT count(*) AS count FROM tasks WHERE project_id = ? AND status = 'TODO'`).get(current.id) as {
          count: number
        }
        invariant(pending.count === 0, 'PROJECT_HAS_OPEN_TASKS', '项目仍有待办任务', { pendingTaskCount: pending.count })
        const series = database
          .prepare(
            `SELECT count(DISTINCT series_id) AS count FROM recurrence_rule_versions
             WHERE project_id = ? AND timeline_active = 1 AND enabled = 1
               AND (effective_to_on_exclusive IS NULL OR effective_to_on_exclusive > ?)`
          )
          .get(current.id, today) as { count: number }
        invariant(series.count === 0, 'PROJECT_HAS_ACTIVE_SERIES', '项目仍有启用中的重复系列', {
          enabledSeriesCount: series.count
        })
      }
      database
        .prepare('UPDATE projects SET status = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?')
        .run(input.status, now, current.id)
      if (current.status !== input.status) {
        database
          .prepare(
            `INSERT INTO project_status_history(id, project_id, old_status, new_status, changed_on, changed_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), current.id, current.status, input.status, today, now)
      }
      return this.getProjectDetail(current.id)
    })
  }

  removeProject(input: { id: string; expectedVersion: number }): MutationEnvelope<void> {
    const now = this.now()
    return this.mutate(
      ['PROJECTS', 'TASKS', 'PLANNING', 'TODAY', 'REVIEW', 'CALENDAR', 'QUADRANTS', 'RECURRENCES', 'GOALS'],
      'project-removed',
      (database) => {
        const current = this.projectCore(input.id, database)
        this.assertVersion(current.row_version, input.expectedVersion)
        // Project deletion is an atomic relational cleanup, including immutable
        // historical recurrence snapshots. Restore the exact guards before commit;
        // any failure rolls back both the data and the transactional DDL.
        const guards = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_rule_immutable_update', 'trg_task_validate_update')").all() as Array<{ name: string; sql: string }>
        for (const guard of guards) database.exec(`DROP TRIGGER ${guard.name}`)
        database.prepare('UPDATE recurrence_series SET updated_at_utc = ?, row_version = row_version + 1 WHERE id IN (SELECT series_id FROM recurrence_rule_versions WHERE project_id = ?)').run(now, current.id)
        database.prepare('UPDATE recurrence_rule_versions SET project_id = NULL WHERE project_id = ?').run(current.id)
        database
          .prepare('UPDATE tasks SET project_id = NULL, updated_at_utc = ?, row_version = row_version + 1 WHERE project_id = ?')
          .run(now, current.id)
        for (const guard of guards) database.exec(guard.sql)
        database.prepare('DELETE FROM project_status_history WHERE project_id = ?').run(current.id)
        database.prepare('DELETE FROM projects WHERE id = ?').run(current.id)
      }
    )
  }

  listRecurrenceSeries(): RecurrenceSeriesDto[] {
    const rows = this.databaseManager.connection
      .prepare('SELECT * FROM recurrence_series ORDER BY created_at_utc DESC, id')
      .all() as SeriesRow[]
    return rows.map((row) => this.mapSeries(row))
  }

  getRecurrenceSeries(id: string): RecurrenceSeriesDto {
    const row = this.seriesCore(id)
    return this.mapSeries(row)
  }

  createRecurrenceSeries(input: CreateRecurrenceSeriesInput): MutationEnvelope<RecurrenceSeriesDto> {
    const today = this.today()
    const now = this.now()
    const id = randomUUID()
    const versionId = randomUUID()
    const snapshot = this.normalizeRuleSnapshot({
      enabled: true,
      title: input.title,
      notes: input.notes,
      projectId: input.projectId,
      important: input.important,
      urgent: input.urgent,
      startOn: input.startOn,
      endOn: input.endOn,
      pattern: input.pattern
    })
    return this.mutate(['RECURRENCES', 'TODAY', 'REVIEW', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'recurrence-created', (database) => {
      this.assertProjectCanReceiveSeries(snapshot.projectId, snapshot.enabled, database)
      database
        .prepare(
          `INSERT INTO recurrence_series(id, created_on, materialized_through_on, created_at_utc, updated_at_utc, row_version)
           VALUES (?, ?, NULL, ?, ?, 1)`
        )
        .run(id, today, now, now)
      this.insertRuleVersion(database, versionId, id, today, snapshot, now)
      this.materializeSeriesThrough(database, id, today, today)
      return this.getRecurrenceSeries(id)
    })
  }

  updateRecurrenceFromDate(input: UpdateRecurrenceFromDateInput): MutationEnvelope<RecurrenceSeriesDto> {
    return this.replaceRecurrenceVersion(input, undefined)
  }

  setRecurrenceEnabledFromDate(input: SetRecurrenceEnabledInput): MutationEnvelope<RecurrenceSeriesDto> {
    return this.replaceRecurrenceVersion(
      { id: input.id, expectedVersion: input.expectedVersion, effectiveOn: input.effectiveOn },
      input.enabled
    )
  }

  applyProjectedOccurrence(input: ApplyProjectedOccurrenceInput): MutationEnvelope<TaskDetailDto> {
    const today = this.today()
    const originalOccurrenceOn = this.date(input.originalOccurrenceOn, 'originalOccurrenceOn')
    const now = this.now()
    return this.mutate(['RECURRENCES', 'TODAY', 'REVIEW', 'PLANNING', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'occurrence-materialized', (database) => {
      const series = this.seriesCore(input.seriesId, database)
      this.assertVersion(series.row_version, input.expectedSeriesRowVersion, 'OCCURRENCE_STALE')
      invariant(originalOccurrenceOn > today, 'OCCURRENCE_STALE', '该未来发生项已到期，请刷新后操作真实任务')
      const version = this.ruleForDate(input.seriesId, originalOccurrenceOn, database)
      invariant(
        version !== undefined && version.id === input.appliedRuleVersionId && this.ruleOccurs(series.created_on, version, originalOccurrenceOn),
        'OCCURRENCE_STALE',
        '该发生项的重复规则已变化，请刷新后重试'
      )
      let task = database
        .prepare('SELECT * FROM tasks WHERE recurrence_series_id = ? AND original_occurrence_on = ?')
        .get(series.id, originalOccurrenceOn) as TaskCoreRow | undefined
      if (task === undefined) {
        this.insertOccurrence(database, series, version, originalOccurrenceOn, today, now)
        task = database
          .prepare('SELECT * FROM tasks WHERE recurrence_series_id = ? AND original_occurrence_on = ?')
          .get(series.id, originalOccurrenceOn) as TaskCoreRow
      }

      let title = task.title
      let notes = task.notes
      let projectId = task.project_id
      let important = task.is_important
      let urgent = task.is_urgent
      let plannedOn = task.planned_on
      let status = task.status
      let completedOn: string | null = status === 'DONE' ? today : null
      let cancelledOn: string | null = status === 'CANCELLED' ? today : null

      if (input.action.kind === 'COMPLETE') {
        status = 'DONE'
        completedOn = today
        cancelledOn = null
      } else if (input.action.kind === 'CANCEL') {
        status = 'CANCELLED'
        cancelledOn = today
        completedOn = null
      } else if (input.action.kind === 'RESCHEDULE') {
        plannedOn = input.action.plannedOn === null ? null : this.date(input.action.plannedOn, 'plannedOn')
      } else {
        const changes = input.action.changes
        if (changes.title !== undefined) title = requireNonBlank(changes.title, '任务标题')
        if (changes.notes !== undefined) notes = normalizeOptionalText(changes.notes)
        if (changes.projectId !== undefined) projectId = changes.projectId
        if (changes.important !== undefined) important = bool(changes.important)
        if (changes.urgent !== undefined) urgent = bool(changes.urgent)
      }
      if (status === 'TODO') this.assertProjectCanReceiveTodo(projectId, database)
      database
        .prepare(
          `UPDATE tasks SET title = ?, notes = ?, project_id = ?, is_important = ?, is_urgent = ?, planned_on = ?,
             status = ?, completed_on = ?, cancelled_on = ?, is_recurrence_exception = 1,
             updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
        )
        .run(title, notes, projectId, important, urgent, plannedOn, status, completedOn, cancelledOn, now, task.id)
      if (task.planned_on !== plannedOn) {
        database
          .prepare(
            `INSERT INTO task_schedule_history(id, task_id, old_planned_on, new_planned_on, changed_on, changed_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), task.id, task.planned_on, plannedOn, today, now)
      }
      if (task.status !== status) {
        database
          .prepare(
            `INSERT INTO task_status_history(id, task_id, old_status, new_status, changed_on, changed_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), task.id, task.status, status, today, now)
      }
      return this.getTaskDetail(task.id)
    })
  }

  getSetting<T>(key: AppSettingKey): T | null {
    const row = this.databaseManager.connection.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row === undefined ? null : (JSON.parse(row.value_json) as T)
  }

  setSetting(key: AppSettingKey, value: unknown): MutationEnvelope<void> {
    validateSetting(key, value)
    const now = this.now()
    return this.mutate(['SETTINGS'], 'setting-updated', (database) => {
      database
        .prepare(
          `INSERT INTO app_settings(key, value_json, updated_at_utc) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc`
        )
        .run(key, JSON.stringify(value), now)
    })
  }

  private replaceRecurrenceVersion(
    input: Pick<UpdateRecurrenceFromDateInput, 'id' | 'expectedVersion' | 'effectiveOn'> & Partial<UpdateRecurrenceFromDateInput>,
    forcedEnabled: boolean | undefined
  ): MutationEnvelope<RecurrenceSeriesDto> {
    const today = this.today()
    const effectiveOn = this.date(input.effectiveOn, 'effectiveOn')
    invariant(effectiveOn >= today, 'RECURRENCE_RULE_INVALID', '重复规则的生效日不能早于今天')
    const now = this.now()
    return this.mutate(['RECURRENCES', 'TODAY', 'REVIEW', 'TASKS', 'CALENDAR', 'QUADRANTS', 'PROJECTS'], 'recurrence-re', (database) => {
      const series = this.seriesCore(input.id, database)
      this.assertVersion(series.row_version, input.expectedVersion)
      const base = this.ruleForDate(series.id, effectiveOn, database) ?? this.ruleForDisplay(series.id, database)
      if (base === undefined) throw new DomainError('RECURRENCE_RULE_INVALID', '重复系列没有可用的规则版本')
      const basePattern = patternFromColumns(base.rule_kind, base.weekday_mask, base.monthly_day)
      const snapshot = this.normalizeRuleSnapshot({
        enabled: forcedEnabled ?? base.enabled === 1,
        title: input.title ?? base.title,
        notes: input.notes === undefined ? base.notes : input.notes,
        projectId: input.projectId === undefined ? base.project_id : input.projectId,
        important: input.important === undefined ? base.is_important === 1 : input.important,
        urgent: input.urgent === undefined ? base.is_urgent === 1 : input.urgent,
        startOn: input.startOn ?? base.rule_start_on,
        endOn: input.endOn === undefined ? base.rule_end_on : input.endOn,
        pattern: input.pattern ?? basePattern
      })
      if (snapshot.projectId !== base.project_id && snapshot.projectId !== null) {
        const targetProject = this.projectCore(snapshot.projectId, database)
        invariant(targetProject.status === 'ACTIVE', 'PROJECT_COMPLETED', '已完成项目不能移入重复系列')
      }
      this.assertProjectCanReceiveSeries(snapshot.projectId, snapshot.enabled, database)

      database
        .prepare(
          `UPDATE recurrence_rule_versions SET timeline_active = 0, retired_at_utc = ?
           WHERE series_id = ? AND timeline_active = 1 AND effective_from_on >= ?`
        )
        .run(now, series.id, effectiveOn)
      database
        .prepare(
          `UPDATE recurrence_rule_versions SET effective_to_on_exclusive = ?, retired_at_utc = ?
           WHERE series_id = ? AND timeline_active = 1 AND effective_from_on < ?
             AND (effective_to_on_exclusive IS NULL OR effective_to_on_exclusive > ?)`
        )
        .run(effectiveOn, now, series.id, effectiveOn, effectiveOn)
      this.insertRuleVersion(database, randomUUID(), series.id, effectiveOn, snapshot, now)
      database
        .prepare('UPDATE recurrence_series SET updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?')
        .run(now, series.id)

      const oldHorizon = series.materialized_through_on
      if (oldHorizon !== null && effectiveOn <= oldHorizon) {
        this.reconcileSeriesRange(database, series.id, effectiveOn, maxDate(oldHorizon, today), today, now)
      } else if (effectiveOn <= today) {
        this.reconcileSeriesRange(database, series.id, effectiveOn, today, today, now)
      }

      let watermark = oldHorizon
      if (effectiveOn <= today) {
        watermark = today
      } else {
        const beforeEffective = LocalDate.parse(effectiveOn).addDays(-1).toString()
        if (watermark === null || watermark > beforeEffective) watermark = beforeEffective
      }
      database.prepare('UPDATE recurrence_series SET materialized_through_on = ? WHERE id = ?').run(watermark, series.id)
      return this.getRecurrenceSeries(series.id)
    })
  }

  private projectOccurrences(startOn: string, endOn: string): ProjectedOccurrenceDto[] {
    const database = this.databaseManager.connection
    const seriesRows = database.prepare('SELECT * FROM recurrence_series').all() as SeriesRow[]
    const occupiedRows = database
      .prepare(
        `SELECT recurrence_series_id, original_occurrence_on FROM tasks
         WHERE recurrence_series_id IS NOT NULL AND original_occurrence_on BETWEEN ? AND ?`
      )
      .all(startOn, endOn) as Array<{ recurrence_series_id: string; original_occurrence_on: string }>
    const occupied = new Set(occupiedRows.map((row) => `${row.recurrence_series_id}:${row.original_occurrence_on}`))
    const result: ProjectedOccurrenceDto[] = []
    const start = LocalDate.parse(startOn)
    const end = LocalDate.parse(endOn)
    for (const series of seriesRows) {
      const versions = this.activeRules(series.id, database)
      for (let cursor = start; !cursor.isAfter(end); cursor = cursor.addDays(1)) {
        const occurrenceOn = cursor.toString()
        const version = versions.find((candidate) => containsDate(candidate, occurrenceOn))
        if (version === undefined || !this.ruleOccurs(series.created_on, version, occurrenceOn)) continue
        if (occupied.has(`${series.id}:${occurrenceOn}`)) continue
        const project =
          version.project_id === null
            ? null
            : (database.prepare('SELECT id, name FROM projects WHERE id = ?').get(version.project_id) as { id: string; name: string } | undefined) ??
              null
        result.push({
          kind: 'PROJECTED_OCCURRENCE',
          occurrenceKey: `projection:${series.id}:${occurrenceOn}`,
          seriesId: series.id,
          expectedSeriesRowVersion: series.row_version,
          appliedRuleVersionId: version.id,
          originalOccurrenceOn: occurrenceOn,
          plannedOn: occurrenceOn,
          title: version.title,
          notes: version.notes,
          project,
          important: version.is_important === 1,
          urgent: version.is_urgent === 1
        })
      }
    }
    return result
  }

  private materializeAllThrough(database: BetterSqlite3.Database, today: string): boolean {
    const seriesRows = database.prepare('SELECT id FROM recurrence_series').all() as Array<{ id: string }>
    let changed = false
    for (const series of seriesRows) {
      changed = this.materializeSeriesThrough(database, series.id, today, today) || changed
    }
    return changed
  }

  private materializeSeriesThrough(database: BetterSqlite3.Database, seriesId: string, throughOn: string, createdOn: string): boolean {
    const series = this.seriesCore(seriesId, database)
    if (series.materialized_through_on !== null && series.materialized_through_on >= throughOn) return false
    const start =
      series.materialized_through_on === null
        ? LocalDate.parse(series.created_on)
        : LocalDate.parse(series.materialized_through_on).addDays(1)
    const end = LocalDate.parse(throughOn)
    const versions = this.activeRules(series.id, database)
    const now = this.now()
    let inserted = false
    for (let cursor = start; !cursor.isAfter(end); cursor = cursor.addDays(1)) {
      const occurrenceOn = cursor.toString()
      const version = versions.find((candidate) => containsDate(candidate, occurrenceOn))
      if (version === undefined || !this.ruleOccurs(series.created_on, version, occurrenceOn)) continue
      inserted = this.insertOccurrence(database, series, version, occurrenceOn, createdOn, now) || inserted
    }
    database.prepare('UPDATE recurrence_series SET materialized_through_on = ? WHERE id = ?').run(throughOn, series.id)
    return inserted
  }

  private reconcileSeriesRange(
    database: BetterSqlite3.Database,
    seriesId: string,
    startOn: string,
    endOn: string,
    createdOn: string,
    now: number
  ): void {
    const series = this.seriesCore(seriesId, database)
    const versions = this.activeRules(series.id, database)
    const pristineRows = database
      .prepare(
        `SELECT * FROM tasks WHERE recurrence_series_id = ? AND original_occurrence_on >= ?
         AND is_recurrence_exception = 0`
      )
      .all(series.id, startOn) as TaskCoreRow[]
    const pristine = new Map(pristineRows.map((row) => [row.original_occurrence_on as string, row]))
    for (const row of pristineRows) {
      const occurrenceOn = row.original_occurrence_on as string
      const version = versions.find((candidate) => containsDate(candidate, occurrenceOn))
      if (version === undefined || !this.ruleOccurs(series.created_on, version, occurrenceOn)) {
        database.prepare('DELETE FROM tasks WHERE id = ?').run(row.id)
      } else {
        database
          .prepare(
            `UPDATE tasks SET title = ?, notes = ?, project_id = ?, is_important = ?, is_urgent = ?, planned_on = ?,
              applied_rule_version_id = ?, updated_at_utc = ?, row_version = row_version + 1 WHERE id = ?`
          )
          .run(
            version.title,
            version.notes,
            version.project_id,
            version.is_important,
            version.is_urgent,
            occurrenceOn,
            version.id,
            now,
            row.id
          )
      }
    }
    const start = LocalDate.parse(startOn)
    const end = LocalDate.parse(endOn)
    for (let cursor = start; !cursor.isAfter(end); cursor = cursor.addDays(1)) {
      const occurrenceOn = cursor.toString()
      const version = versions.find((candidate) => containsDate(candidate, occurrenceOn))
      if (version === undefined || !this.ruleOccurs(series.created_on, version, occurrenceOn)) continue
      if (!pristine.has(occurrenceOn)) this.insertOccurrence(database, series, version, occurrenceOn, createdOn, now)
    }
  }

  private insertOccurrence(
    database: BetterSqlite3.Database,
    series: SeriesRow,
    version: RuleVersionRow,
    occurrenceOn: string,
    createdOn: string,
    now: number
  ): boolean {
    const result = database
      .prepare(
        `INSERT INTO tasks(
          id, title, notes, planned_on, status, project_id, parent_task_id, is_important, is_urgent,
          completed_on, cancelled_on, recurrence_series_id, applied_rule_version_id, original_occurrence_on,
          is_recurrence_exception, created_on, created_at_utc, updated_at_utc, row_version
        ) VALUES (?, ?, ?, ?, 'TODO', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, 0, ?, ?, ?, 1)
        ON CONFLICT(recurrence_series_id, original_occurrence_on)
        WHERE recurrence_series_id IS NOT NULL DO NOTHING`
      )
      .run(
        randomUUID(),
        version.title,
        version.notes,
        occurrenceOn,
        version.project_id,
        version.is_important,
        version.is_urgent,
        series.id,
        version.id,
        occurrenceOn,
        createdOn,
        now,
        now
      )
    return result.changes > 0
  }

  private activeRules(seriesId: string, database: BetterSqlite3.Database): RuleVersionRow[] {
    return database
      .prepare(
        `SELECT * FROM recurrence_rule_versions WHERE series_id = ? AND timeline_active = 1
         ORDER BY effective_from_on, id`
      )
      .all(seriesId) as RuleVersionRow[]
  }

  private ruleForDate(seriesId: string, date: string, database: BetterSqlite3.Database): RuleVersionRow | undefined {
    return database
      .prepare(
        `SELECT * FROM recurrence_rule_versions
         WHERE series_id = ? AND timeline_active = 1 AND effective_from_on <= ?
           AND (effective_to_on_exclusive IS NULL OR effective_to_on_exclusive > ?)
         ORDER BY effective_from_on DESC LIMIT 1`
      )
      .get(seriesId, date, date) as RuleVersionRow | undefined
  }

  private ruleForDisplay(seriesId: string, database: BetterSqlite3.Database): RuleVersionRow | undefined {
    const today = this.today()
    return (
      this.ruleForDate(seriesId, today, database) ??
      (database
        .prepare(
          `SELECT * FROM recurrence_rule_versions WHERE series_id = ? AND timeline_active = 1
           ORDER BY effective_from_on LIMIT 1`
        )
        .get(seriesId) as RuleVersionRow | undefined)
    )
  }

  private ruleOccurs(seriesCreatedOn: string, version: RuleVersionRow, date: string): boolean {
    return occursOn(seriesCreatedOn, rowRule(version), date)
  }

  private mapSeries(series: SeriesRow): RecurrenceSeriesDto {
    const database = this.databaseManager.connection
    const version = this.ruleForDisplay(series.id, database)
    if (version === undefined) throw new DomainError('DATABASE_ERROR', '重复系列缺少有效规则')
    const project =
      version.project_id === null
        ? null
        : (database.prepare('SELECT id, name FROM projects WHERE id = ?').get(version.project_id) as { id: string; name: string } | undefined) ?? null
    return {
      id: series.id,
      version: series.row_version,
      enabled: version.enabled === 1,
      title: version.title,
      notes: version.notes,
      project,
      important: version.is_important === 1,
      urgent: version.is_urgent === 1,
      startOn: version.rule_start_on,
      endOn: version.rule_end_on,
      pattern: patternFromColumns(version.rule_kind, version.weekday_mask, version.monthly_day),
      effectiveFromOn: version.effective_from_on,
      createdOn: series.created_on
    }
  }

  private insertRuleVersion(
    database: BetterSqlite3.Database,
    id: string,
    seriesId: string,
    effectiveOn: string,
    snapshot: NormalizedRuleSnapshot,
    now: number
  ): void {
    database
      .prepare(
        `INSERT INTO recurrence_rule_versions(
          id, series_id, effective_from_on, effective_to_on_exclusive, timeline_active, enabled,
          title, notes, project_id, is_important, is_urgent, rule_kind, rule_start_on, rule_end_on,
          weekday_mask, monthly_day, created_at_utc, retired_at_utc
        ) VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        seriesId,
        effectiveOn,
        bool(snapshot.enabled),
        snapshot.title,
        snapshot.notes,
        snapshot.projectId,
        bool(snapshot.important),
        bool(snapshot.urgent),
        snapshot.pattern.kind,
        snapshot.startOn,
        snapshot.endOn,
        weekdayMask(snapshot.pattern),
        snapshot.pattern.kind === 'MONTHLY' ? snapshot.pattern.monthlyDay : null,
        now
      )
  }

  private normalizeRuleSnapshot(input: {
    enabled: boolean
    title: string
    notes?: string | null
    projectId?: string | null
    important?: boolean
    urgent?: boolean
    startOn: string
    endOn?: string | null
    pattern: RecurrencePatternDto
  }): NormalizedRuleSnapshot {
    const startOn = this.date(input.startOn, 'startOn')
    const endOn = input.endOn == null ? null : this.date(input.endOn, 'endOn')
    invariant(endOn === null || endOn >= startOn, 'RECURRENCE_RULE_INVALID', '重复结束日不能早于开始日')
    return {
      enabled: input.enabled,
      title: requireNonBlank(input.title, '重复任务标题'),
      notes: normalizeOptionalText(input.notes),
      projectId: input.projectId ?? null,
      important: input.important ?? false,
      urgent: input.urgent ?? false,
      startOn,
      endOn,
      pattern: validateRecurrencePattern(input.pattern)
    }
  }

  private setReviewState(
    column: 'dismissed_at_utc' | 'started_at_utc' | 'finished_at_utc',
    expectedLocalDate: string,
    reason: string
  ): MutationEnvelope<void> {
    const today = this.today()
    invariant(expectedLocalDate === today, 'STALE_DAY_CONTEXT', '日期已变化，请刷新页面', { currentLocalDate: today })
    const now = this.now()
    return this.mutate(['TODAY', 'REVIEW'], reason, (database) => {
      database
        .prepare(
          `INSERT INTO daily_review_state(review_on, first_opened_at_utc, ${column}) VALUES (?, ?, ?)
           ON CONFLICT(review_on) DO UPDATE SET ${column} = excluded.${column}`
        )
        .run(today, now, now)
    })
  }

  private mapProject(row: ProjectRow): ProjectDto {
    const tasks = this.taskRows('task.project_id = ?', [row.id]).map((task) => mapTaskRow(task, this.today()))
    return {
      id: row.id,
      version: row.row_version,
      name: row.name,
      description: row.description,
      goal: row.goal_id === null || row.goal_name === null ? null : { id: row.goal_id, name: row.goal_name },
      status: row.status,
      tasks,
      pendingTaskCount: row.pending_task_count,
      pendingExecutableCount: row.pending_executable_count,
      enabledSeriesCount: row.enabled_series_count,
      hasNextAction: row.pending_executable_count > 0,
      createdAtUtc: new Date(row.created_at_utc).toISOString(),
      updatedAtUtc: new Date(row.updated_at_utc).toISOString()
    }
  }

  private mutate<T>(tags: ChangeNoticeDto['tags'], reason: string, work: (database: BetterSqlite3.Database) => T): MutationEnvelope<T> {
    let revision = 0
    const value = this.databaseManager.immediate((database) => {
      const result = work(database)
      revision = this.databaseManager.bumpRevision(database)
      return result
    })
    return { value, change: this.notice(revision, reason, tags) }
  }

  private notice(revision: number, reason: string, tags: ChangeNoticeDto['tags']): ChangeNoticeDto {
    return { dataEpoch: this.databaseManager.dataEpoch, revision, reason, tags }
  }

  private ensureReconciled(): void {
    if (this.databaseManager.metadata.lastReconciledOn !== this.today()) this.reconcile()
  }

  private taskRows(where: string, parameters: unknown[]): TaskJoinedRow[] {
    return this.databaseManager.connection
      .prepare(`${TASK_SELECT} WHERE ${where} ORDER BY task.planned_on IS NULL, task.planned_on, task.created_at_utc, task.id`)
      .all(...parameters) as TaskJoinedRow[]
  }

  private taskRowById(id: string): TaskJoinedRow | undefined {
    return this.databaseManager.connection.prepare(`${TASK_SELECT} WHERE task.id = ?`).get(id) as TaskJoinedRow | undefined
  }

  private taskCore(id: string, database: BetterSqlite3.Database = this.databaseManager.connection): TaskCoreRow {
    const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskCoreRow | undefined
    if (task === undefined) throw new DomainError('NOT_FOUND', '任务不存在')
    return task
  }

  private projectCore(id: string, database: BetterSqlite3.Database = this.databaseManager.connection): {
    id: string
    goal_id: string | null
    name: string
    description: string | null
    status: ProjectStatus
    row_version: number
  } {
    const project = database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | { id: string; goal_id: string | null; name: string; description: string | null; status: ProjectStatus; row_version: number }
      | undefined
    if (project === undefined) throw new DomainError('NOT_FOUND', '项目不存在')
    return project
  }

  private goalCore(id: string, database: BetterSqlite3.Database = this.databaseManager.connection): {
    id: string
    name: string
    description: string | null
    category_id: string | null
    priority: GoalPriority | null
    period_kind: GoalPeriodDto['kind']
    period_start_on: string | null
    period_end_on: string | null
    status: GoalStatus
    row_version: number
  } {
    const goal = database.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
      | {
          id: string
          name: string
          description: string | null
          category_id: string | null
          priority: GoalPriority | null
          period_kind: GoalPeriodDto['kind']
          period_start_on: string | null
          period_end_on: string | null
          status: GoalStatus
          row_version: number
        }
      | undefined
    if (goal === undefined) throw new DomainError('NOT_FOUND', '目标不存在')
    return goal
  }

  private seriesCore(id: string, database: BetterSqlite3.Database = this.databaseManager.connection): SeriesRow {
    const series = database.prepare('SELECT * FROM recurrence_series WHERE id = ?').get(id) as SeriesRow | undefined
    if (series === undefined) throw new DomainError('NOT_FOUND', '重复系列不存在')
    return series
  }

  private childCount(id: string, database: BetterSqlite3.Database): number {
    return (database.prepare('SELECT count(*) AS count FROM tasks WHERE parent_task_id = ?').get(id) as { count: number }).count
  }

  private pendingChildCount(id: string, database: BetterSqlite3.Database): number {
    return (database.prepare(`SELECT count(*) AS count FROM tasks WHERE parent_task_id = ? AND status = 'TODO'`).get(id) as { count: number })
      .count
  }

  private assertVersion(actual: number, expected: number, code: 'VERSION_CONFLICT' | 'OCCURRENCE_STALE' = 'VERSION_CONFLICT'): void {
    invariant(actual === expected, code, '数据已发生变化，请刷新后重试', { expectedVersion: expected, actualVersion: actual })
  }

  private assertProjectCanReceiveTodo(projectId: string | null | undefined, database: BetterSqlite3.Database): void {
    if (projectId == null) return
    const project = this.projectCore(projectId, database)
    invariant(project.status === 'ACTIVE', 'PROJECT_COMPLETED', '已完成项目不能接收待办任务')
  }

  private assertProjectCanReceiveSeries(projectId: string | null, enabled: boolean, database: BetterSqlite3.Database): void {
    if (projectId === null) return
    const project = this.projectCore(projectId, database)
    if (enabled) invariant(project.status === 'ACTIVE', 'PROJECT_COMPLETED', '已完成项目不能接收启用的重复系列')
  }

  private assertCategoryExists(categoryId: string | null, database: BetterSqlite3.Database): void {
    if (categoryId === null) return
    const found = database.prepare('SELECT 1 AS found FROM goal_categories WHERE id = ?').get(categoryId)
    if (found === undefined) throw new DomainError('NOT_FOUND', '目标分类不存在')
  }

  private assertGoalExists(goalId: string | null, database: BetterSqlite3.Database): void {
    if (goalId === null) return
    const found = database.prepare('SELECT 1 AS found FROM goals WHERE id = ?').get(goalId)
    if (found === undefined) throw new DomainError('NOT_FOUND', '目标不存在')
  }

  private insertGoalHistory(
    database: BetterSqlite3.Database,
    goalId: string,
    oldStatus: GoalStatus,
    newStatus: GoalStatus,
    changedOn: string,
    changedAt: number
  ): void {
    database
      .prepare(
        `INSERT INTO goal_status_history(id, goal_id, old_status, new_status, changed_on, changed_at_utc)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), goalId, oldStatus, newStatus, changedOn, changedAt)
  }

  private requireConfirmation(
    suppliedToken: string | undefined,
    kind: ConfirmationRecord['kind'],
    entityId: string,
    expectedVersion: number,
    target: string,
    facts: Record<string, number>,
    description: string
  ): void {
    if (suppliedToken !== undefined) {
      const record = this.confirmations.get(suppliedToken)
      this.confirmations.delete(suppliedToken)
      invariant(record !== undefined && record.expiresAtUtcMs >= this.now(), 'CONFIRMATION_EXPIRED', '确认已过期，请重新操作')
      invariant(
        record.kind === kind &&
          record.entityId === entityId &&
          record.expectedVersion === expectedVersion &&
          record.target === target &&
          sameFacts(record.facts, facts),
        'CONFIRMATION_EXPIRED',
        '数据或风险事实已变化，请重新确认'
      )
      return
    }
    const token = randomUUID()
    const expiresAtUtcMs = this.now() + 5 * 60_000
    this.confirmations.set(token, { kind, entityId, expectedVersion, target, facts, expiresAtUtcMs })
    throw new DomainError('CONFIRMATION_REQUIRED', description, {
      confirmationToken: token,
      kind,
      facts,
      expiresAtUtc: new Date(expiresAtUtcMs).toISOString()
    })
  }

  private today(): string {
    return this.dates.today().toString()
  }

  private now(): number {
    return this.dates.nowUtcMs()
  }

  private date(value: string, field: string): string {
    try {
      return LocalDate.parse(value).toString()
    } catch {
      throw new DomainError('VALIDATION_FAILED', `${field} 必须是有效的 YYYY-MM-DD`)
    }
  }
}

interface NormalizedRuleSnapshot {
  enabled: boolean
  title: string
  notes: string | null
  projectId: string | null
  important: boolean
  urgent: boolean
  startOn: string
  endOn: string | null
  pattern: RecurrencePatternDto
}

export type AppSettingKey = 'calendar.defaultView' | 'today.reviewCardEnabled'

function validateSetting(key: AppSettingKey, value: unknown): void {
  if (key === 'calendar.defaultView' && value !== 'WEEK' && value !== 'MONTH') {
    throw new DomainError('VALIDATION_FAILED', '日历默认视图必须是 WEEK 或 MONTH')
  }
  if (key === 'today.reviewCardEnabled' && typeof value !== 'boolean') {
    throw new DomainError('VALIDATION_FAILED', '复盘卡片开关必须是布尔值')
  }
}

function mapGoal(row: GoalRow): GoalDto {
  return {
    id: row.id,
    version: row.row_version,
    name: row.name,
    description: row.description,
    category: row.category_id === null || row.category_name === null ? null : { id: row.category_id, name: row.category_name },
    priority: row.priority,
    period: rowPeriod(row.period_kind, row.period_start_on, row.period_end_on),
    status: row.status,
    projectCount: row.project_count,
    activeProjectCount: row.active_project_count,
    createdAtUtc: new Date(row.created_at_utc).toISOString(),
    updatedAtUtc: new Date(row.updated_at_utc).toISOString()
  }
}

function rowPeriod(kind: GoalPeriodDto['kind'], startOn: string | null, endOn: string | null): GoalPeriodDto {
  if (kind === 'NONE') return { kind: 'NONE', startOn: null, endOn: null }
  if (startOn === null || endOn === null) throw new DomainError('DATABASE_ERROR', '目标周期数据不完整')
  return { kind, startOn, endOn }
}

function rowRule(version: RuleVersionRow): RecurrenceRule {
  return {
    enabled: version.enabled === 1,
    effectiveFromOn: version.effective_from_on,
    effectiveToOnExclusive: version.effective_to_on_exclusive,
    ruleStartOn: version.rule_start_on,
    ruleEndOn: version.rule_end_on,
    pattern: patternFromColumns(version.rule_kind, version.weekday_mask, version.monthly_day)
  }
}

function containsDate(version: RuleVersionRow, date: string): boolean {
  return version.effective_from_on <= date && (version.effective_to_on_exclusive === null || date < version.effective_to_on_exclusive)
}

function leafPredicate(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM tasks leaf_child WHERE leaf_child.parent_task_id = ${alias}.id)`
}

function bool(value: boolean | undefined): number {
  return value === true ? 1 : 0
}

function normalizeCategory(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function sameFacts(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}
