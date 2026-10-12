import type BetterSqlite3 from 'better-sqlite3'
import { DomainError } from '../domain/errors'
import { validateAndNormalizeGoalPeriod } from '../domain/goal-period'
import { LocalDate } from '../domain/local-date'
import { patternFromColumns, validateRecurrencePattern } from '../domain/recurrence'

export interface DomainValidationIssue {
  code: string
  table: string
  entityId?: string
}

/** Explicit schema catalogue used by backup readers; never SELECT * from untrusted input. */
export const DOMAIN_TABLE_COLUMNS = {
  app_settings: ['key', 'value_json', 'updated_at_utc'],
  goal_categories: ['id', 'name', 'normalized_name', 'created_at_utc', 'updated_at_utc'],
  goals: [
    'id',
    'name',
    'description',
    'category_id',
    'priority',
    'period_kind',
    'period_start_on',
    'period_end_on',
    'status',
    'created_at_utc',
    'updated_at_utc',
    'row_version'
  ],
  projects: ['id', 'goal_id', 'name', 'description', 'status', 'created_at_utc', 'updated_at_utc', 'row_version'],
  recurrence_series: ['id', 'created_on', 'materialized_through_on', 'created_at_utc', 'updated_at_utc', 'row_version'],
  recurrence_rule_versions: [
    'id',
    'series_id',
    'effective_from_on',
    'effective_to_on_exclusive',
    'timeline_active',
    'enabled',
    'title',
    'notes',
    'project_id',
    'is_important',
    'is_urgent',
    'rule_kind',
    'rule_start_on',
    'rule_end_on',
    'weekday_mask',
    'monthly_day',
    'created_at_utc',
    'retired_at_utc'
  ],
  tasks: [
    'goal_id',
    'id',
    'title',
    'notes',
    'planned_on',
    'planned_start_on',
    'status',
    'project_id',
    'parent_task_id',
    'is_important',
    'is_urgent',
    'completed_on',
    'cancelled_on',
    'recurrence_series_id',
    'applied_rule_version_id',
    'original_occurrence_on',
    'is_recurrence_exception',
    'created_on',
    'created_at_utc',
    'updated_at_utc',
    'row_version'
  ],
  task_schedule_history: ['event_seq', 'id', 'task_id', 'old_planned_on', 'new_planned_on', 'changed_on', 'changed_at_utc', 'old_planned_start_on', 'new_planned_start_on'],
  task_status_history: ['event_seq', 'id', 'task_id', 'old_status', 'new_status', 'changed_on', 'changed_at_utc'],
  project_status_history: ['event_seq', 'id', 'project_id', 'old_status', 'new_status', 'changed_on', 'changed_at_utc'],
  goal_status_history: ['event_seq', 'id', 'goal_id', 'old_status', 'new_status', 'changed_on', 'changed_at_utc'],
  daily_review_state: ['review_on', 'first_opened_at_utc', 'dismissed_at_utc', 'started_at_utc', 'finished_at_utc']
} as const

export const DOMAIN_TABLE_ORDER = Object.keys(DOMAIN_TABLE_COLUMNS) as Array<keyof typeof DOMAIN_TABLE_COLUMNS>

export function domainColumnsForSchema(table: keyof typeof DOMAIN_TABLE_COLUMNS, version: number): string[] {
  return DOMAIN_TABLE_COLUMNS[table].filter((column) => {
    if (table === 'tasks' && column === 'goal_id') return version >= 2
    if (column === 'planned_start_on' || column === 'old_planned_start_on' || column === 'new_planned_start_on') return version >= 3
    return true
  })
}

const DATE_COLUMNS: Partial<Record<keyof typeof DOMAIN_TABLE_COLUMNS, readonly string[]>> = {
  goals: ['period_start_on', 'period_end_on'],
  recurrence_series: ['created_on', 'materialized_through_on'],
  recurrence_rule_versions: ['effective_from_on', 'effective_to_on_exclusive', 'rule_start_on', 'rule_end_on'],
  tasks: ['planned_on', 'planned_start_on', 'completed_on', 'cancelled_on', 'original_occurrence_on', 'created_on'],
  task_schedule_history: ['old_planned_on', 'new_planned_on', 'old_planned_start_on', 'new_planned_start_on', 'changed_on'],
  task_status_history: ['changed_on'],
  project_status_history: ['changed_on'],
  goal_status_history: ['changed_on'],
  daily_review_state: ['review_on']
}

/**
 * Validates invariants that are not fully expressible as SQLite CHECK/FK constraints.
 * The result contains only table/id metadata and is safe to log without user text.
 */
export function validateDomainInvariants(database: BetterSqlite3.Database, todayValue: string): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = []
  const schemaVersion = database.pragma('user_version', { simple: true }) as number
  let today: string
  try {
    today = LocalDate.parse(todayValue).toString()
  } catch {
    return [{ code: 'INVALID_VALIDATION_DATE', table: 'database_meta' }]
  }

  for (const table of DOMAIN_TABLE_ORDER) {
    const columns = DATE_COLUMNS[table]?.filter((column) => domainColumnsForSchema(table, schemaVersion).includes(column))
    if (columns === undefined) continue
    const selected = ['id', 'event_seq', ...columns]
      .filter((column, index, all) => all.indexOf(column) === index && DOMAIN_TABLE_COLUMNS[table].includes(column as never))
      .map(quoteIdentifier)
      .join(', ')
    const rows = database.prepare(`SELECT ${selected} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column]
        if (value === null) continue
        if (typeof value !== 'string' || LocalDate.tryParse(value) === null) {
          issues.push({ code: `INVALID_DATE:${column}`, table, entityId: entityIdentity(row) })
        }
      }
    }
  }

  if (schemaVersion >= 3) appendQueryIssues(database, issues,
    'SELECT id FROM tasks WHERE planned_start_on > planned_on', 'INVALID_TASK_DATE_RANGE', 'tasks')

  const goals = database
    .prepare('SELECT id, period_kind, period_start_on, period_end_on FROM goals')
    .all() as Array<{ id: string; period_kind: 'NONE' | 'MONTH' | 'QUARTER' | 'YEAR' | 'CUSTOM'; period_start_on: string | null; period_end_on: string | null }>
  for (const goal of goals) {
    try {
      validateAndNormalizeGoalPeriod(
        goal.period_kind === 'NONE'
          ? { kind: 'NONE', startOn: null, endOn: null }
          : { kind: goal.period_kind, startOn: goal.period_start_on as string, endOn: goal.period_end_on as string }
      )
    } catch {
      issues.push({ code: 'INVALID_GOAL_PERIOD', table: 'goals', entityId: goal.id })
    }
  }

  const categories = database.prepare('SELECT id, name, normalized_name FROM goal_categories').all() as Array<{
    id: string
    name: string
    normalized_name: string
  }>
  for (const category of categories) {
    if (category.name.normalize('NFKC').toLowerCase() !== category.normalized_name) {
      issues.push({ code: 'INVALID_CATEGORY_NORMALIZATION', table: 'goal_categories', entityId: category.id })
    }
  }

  appendQueryIssues(
    database,
    issues,
    `SELECT child.id FROM tasks child JOIN tasks parent ON parent.id = child.parent_task_id
     WHERE parent.parent_task_id IS NOT NULL`,
    'TASK_DEPTH_EXCEEDED',
    'tasks'
  )
  appendQueryIssues(
    database,
    issues,
    `SELECT child.id FROM tasks child JOIN tasks parent ON parent.id = child.parent_task_id
     WHERE child.project_scope <> parent.project_scope`,
    'PARENT_PROJECT_MISMATCH',
    'tasks'
  )
  appendQueryIssues(
    database,
    issues,
    `SELECT task.id FROM tasks task
     WHERE task.recurrence_series_id IS NOT NULL
       AND (task.parent_task_id IS NOT NULL OR EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = task.id))`,
    'RECURRENCE_RELATION_FORBIDDEN',
    'tasks'
  )
  appendQueryIssues(
    database,
    issues,
    `SELECT task.id FROM tasks task
     LEFT JOIN recurrence_rule_versions version
       ON version.id = task.applied_rule_version_id AND version.series_id = task.recurrence_series_id
     WHERE task.recurrence_series_id IS NOT NULL AND (
       version.id IS NULL OR
       (task.is_recurrence_exception = 0 AND NOT (
         task.status = 'TODO' AND task.planned_on = task.original_occurrence_on
         AND task.title = version.title AND task.notes IS version.notes AND task.project_id IS version.project_id
         AND task.is_important = version.is_important AND task.is_urgent = version.is_urgent
         AND ${schemaVersion >= 3 ? 'task.planned_start_on IS NULL' : '1 = 1'}
       )) OR
       (task.status <> 'TODO' AND task.is_recurrence_exception = 0)
     )`,
    'RECURRENCE_INSTANCE_INVALID',
    'tasks'
  )
  appendQueryIssues(
    database,
    issues,
    `SELECT project.id FROM projects project
     WHERE project.status = 'COMPLETED' AND EXISTS (
       SELECT 1 FROM tasks task WHERE task.project_id = project.id AND task.status = 'TODO'
     )`,
    'PROJECT_HAS_OPEN_TASKS',
    'projects'
  )
  appendQueryIssues(
    database,
    issues,
    `SELECT project.id FROM projects project
     WHERE project.status = 'COMPLETED' AND EXISTS (
       SELECT 1 FROM recurrence_rule_versions version
       WHERE version.project_id = project.id AND version.timeline_active = 1 AND version.enabled = 1
         AND (version.effective_to_on_exclusive IS NULL OR version.effective_to_on_exclusive > ?)
     )`,
    'PROJECT_HAS_ACTIVE_SERIES',
    'projects',
    [today]
  )

  const seriesRows = database.prepare('SELECT id, created_on FROM recurrence_series').all() as Array<{ id: string; created_on: string }>
  for (const series of seriesRows) {
    const versions = database
      .prepare(
        `SELECT * FROM recurrence_rule_versions WHERE series_id = ? AND timeline_active = 1
         ORDER BY effective_from_on, id`
      )
      .all(series.id) as Array<{
      id: string
      effective_from_on: string
      effective_to_on_exclusive: string | null
      rule_kind: 'DAILY' | 'WEEKLY' | 'MONTHLY'
      weekday_mask: number
      monthly_day: number | null
    }>
    if (versions.length === 0 || versions[0]?.effective_from_on !== series.created_on) {
      issues.push({ code: 'RECURRENCE_TIMELINE_START_INVALID', table: 'recurrence_series', entityId: series.id })
      continue
    }
    for (let index = 0; index < versions.length; index += 1) {
      const version = versions[index]
      if (version === undefined) continue
      try {
        validateRecurrencePattern(patternFromColumns(version.rule_kind, version.weekday_mask, version.monthly_day))
      } catch {
        issues.push({ code: 'RECURRENCE_RULE_INVALID', table: 'recurrence_rule_versions', entityId: version.id })
      }
      const next = versions[index + 1]
      if (next === undefined) {
        if (version.effective_to_on_exclusive !== null) {
          issues.push({ code: 'RECURRENCE_TIMELINE_NO_OPEN_TAIL', table: 'recurrence_series', entityId: series.id })
        }
      } else if (version.effective_to_on_exclusive !== next.effective_from_on) {
        issues.push({ code: 'RECURRENCE_TIMELINE_GAP_OR_OVERLAP', table: 'recurrence_series', entityId: series.id })
      }
    }
  }

  return issues
}

export function assertDomainInvariants(database: BetterSqlite3.Database, today: string): void {
  const issues = validateDomainInvariants(database, today)
  if (issues.length > 0) {
    throw new DomainError('BACKUP_INVALID_RELATION', '数据包含无效状态或关联关系', {
      issueCount: issues.length,
      issues: issues.slice(0, 50)
    })
  }
}

function appendQueryIssues(
  database: BetterSqlite3.Database,
  issues: DomainValidationIssue[],
  sql: string,
  code: string,
  table: string,
  parameters: unknown[] = []
): void {
  const rows = database.prepare(sql).all(...parameters) as Array<{ id: string }>
  for (const row of rows) issues.push({ code, table, entityId: row.id })
}

function entityIdentity(row: Record<string, unknown>): string | undefined {
  if (typeof row.id === 'string') return row.id
  if (typeof row.review_on === 'string') return row.review_on
  if (typeof row.event_seq === 'number') return String(row.event_seq)
  return undefined
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
