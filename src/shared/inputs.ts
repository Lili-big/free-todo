import type { GoalPeriodDto, GoalPriority, GoalStatus, LocalDate, ProjectStatus, RecurrencePatternDto, TaskStatus } from './types'

export interface ConnectWecomCalendarInput {
  server: string
  account?: string
  username?: string
  password: string
}

export interface ExternalCalendarRangeInput {
  startOn: LocalDate
  endOn: LocalDate
}

export interface CreateTaskInput {
  goalId?: string | null
  title: string
  notes?: string | null
  plannedOn?: LocalDate | null
  projectId?: string | null
  parentTaskId?: string | null
  important?: boolean
  urgent?: boolean
}

export interface UpdateTaskContentInput {
  goalId?: string | null
  id: string
  expectedVersion: number
  title?: string
  notes?: string | null
  important?: boolean
  urgent?: boolean
}

export interface SetTaskScheduleInput {
  id: string
  expectedVersion: number
  plannedOn: LocalDate | null
}

export interface ChangeTaskStatusInput {
  id: string
  expectedVersion: number
  status: TaskStatus
  confirmationToken?: string
}

export interface CreateChildTaskInput extends Omit<CreateTaskInput, 'parentTaskId' | 'projectId'> {
  parentId: string
  parentExpectedVersion: number
}

export interface ChangeTaskParentInput {
  id: string
  expectedVersion: number
  parentId: string | null
  confirmationToken?: string
}

export interface CreateParentAndAttachInput {
  childId: string
  childExpectedVersion: number
  title: string
}

export interface MoveTaskTreeInput {
  id: string
  expectedVersion: number
  projectId: string | null
  confirmationToken?: string
}

export interface CreateNextStepInput extends Omit<CreateTaskInput, 'projectId' | 'parentTaskId'> {
  sourceTaskId: string
}

export interface TaskListQuery {
  goalId?: string | null
  status?: TaskStatus | 'ALL'
  projectId?: string | null
  parentId?: string | null
  search?: string
  page?: number
  pageSize?: number
}

export interface CreateProjectInput {
  name: string
  description?: string | null
  goalId?: string | null
}

export interface UpdateProjectInput {
  id: string
  expectedVersion: number
  name?: string
  description?: string | null
  goalId?: string | null
}

export interface ChangeProjectStatusInput {
  id: string
  expectedVersion: number
  status: ProjectStatus
}

export interface CreateGoalInput {
  name: string
  description?: string | null
  categoryId?: string | null
  priority?: GoalPriority | null
  period?: GoalPeriodDto
}

export interface UpdateGoalInput extends Partial<Omit<CreateGoalInput, 'name'>> {
  id: string
  expectedVersion: number
  name?: string
}

export interface ChangeGoalStatusInput {
  id: string
  expectedVersion: number
  status: GoalStatus
  period?: GoalPeriodDto
  confirmationToken?: string
}

export interface GoalListQuery {
  status?: GoalStatus | 'ALL'
  categoryId?: string | null
  priority?: GoalPriority | 'UNSET' | 'ALL'
}

export interface CreateRecurrenceSeriesInput {
  title: string
  notes?: string | null
  projectId?: string | null
  important?: boolean
  urgent?: boolean
  startOn: LocalDate
  endOn?: LocalDate | null
  pattern: RecurrencePatternDto
}

export interface UpdateRecurrenceFromDateInput extends Partial<Omit<CreateRecurrenceSeriesInput, 'startOn'>> {
  id: string
  expectedVersion: number
  effectiveOn: LocalDate
  startOn?: LocalDate
}

export interface SetRecurrenceEnabledInput {
  id: string
  expectedVersion: number
  effectiveOn: LocalDate
  enabled: boolean
}

export type OccurrenceAction =
  | { kind: 'COMPLETE' }
  | { kind: 'CANCEL' }
  | { kind: 'RESCHEDULE'; plannedOn: LocalDate | null }
  | { kind: 'EDIT'; changes: { title?: string; notes?: string | null; important?: boolean; urgent?: boolean; projectId?: string | null } }

export interface ApplyProjectedOccurrenceInput {
  seriesId: string
  originalOccurrenceOn: LocalDate
  expectedSeriesRowVersion: number
  appliedRuleVersionId: string
  action: OccurrenceAction
}
