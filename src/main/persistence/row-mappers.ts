import type { TaskListItemDto, TaskStatus } from '@shared/types'

export interface TaskJoinedRow {
  goal_id: string | null
  goal_name: string | null
  id: string
  row_version: number
  title: string
  notes: string | null
  status: TaskStatus
  planned_on: string | null
  completed_on: string | null
  cancelled_on: string | null
  is_important: number
  is_urgent: number
  recurrence_series_id: string | null
  original_occurrence_on: string | null
  is_recurrence_exception: number
  created_at_utc: number
  updated_at_utc: number
  project_id: string | null
  project_name: string | null
  project_status: 'ACTIVE' | 'COMPLETED' | null
  parent_task_id: string | null
  parent_title: string | null
  parent_status: TaskStatus | null
  child_count: number
  pending_child_count: number
}

export const TASK_SELECT = `
SELECT
  task.goal_id,
  goal.name AS goal_name,
  task.id,
  task.row_version,
  task.title,
  task.notes,
  task.status,
  task.planned_on,
  task.completed_on,
  task.cancelled_on,
  task.is_important,
  task.is_urgent,
  task.recurrence_series_id,
  task.original_occurrence_on,
  task.is_recurrence_exception,
  task.created_at_utc,
  task.updated_at_utc,
  task.project_id,
  project.name AS project_name,
  project.status AS project_status,
  task.parent_task_id,
  parent.title AS parent_title,
  parent.status AS parent_status,
  (SELECT count(*) FROM tasks child WHERE child.parent_task_id = task.id) AS child_count,
  (SELECT count(*) FROM tasks child WHERE child.parent_task_id = task.id AND child.status = 'TODO') AS pending_child_count
FROM tasks task
LEFT JOIN goals goal ON goal.id = task.goal_id
LEFT JOIN projects project ON project.id = task.project_id
LEFT JOIN tasks parent ON parent.id = task.parent_task_id
`

export function mapTaskRow(row: TaskJoinedRow, today: string): TaskListItemDto {
  const hasChildren = row.child_count > 0
  return {
    goal: row.goal_id && row.goal_name ? { id: row.goal_id, name: row.goal_name } : null,
    id: row.id,
    version: row.row_version,
    title: row.title,
    notes: row.notes,
    status: row.status,
    plannedOn: row.planned_on,
    completedOn: row.completed_on,
    cancelledOn: row.cancelled_on,
    important: row.is_important === 1,
    urgent: row.is_urgent === 1,
    project:
      row.project_id === null || row.project_name === null || row.project_status === null
        ? null
        : { id: row.project_id, name: row.project_name, status: row.project_status },
    parent:
      row.parent_task_id === null || row.parent_title === null || row.parent_status === null
        ? null
        : { id: row.parent_task_id, title: row.parent_title, status: row.parent_status },
    hasChildren,
    isExecutable: !hasChildren,
    pendingChildCount: row.pending_child_count,
    isOverdue: !hasChildren && row.status === 'TODO' && row.planned_on !== null && row.planned_on < today,
    recurrence:
      row.recurrence_series_id === null || row.original_occurrence_on === null
        ? null
        : {
            seriesId: row.recurrence_series_id,
            originalOccurrenceOn: row.original_occurrence_on,
            isException: row.is_recurrence_exception === 1
          },
    createdAtUtc: new Date(row.created_at_utc).toISOString(),
    updatedAtUtc: new Date(row.updated_at_utc).toISOString()
  }
}
