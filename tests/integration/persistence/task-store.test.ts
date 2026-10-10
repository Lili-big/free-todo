import { DomainError } from '../../../src/main/domain/errors'
import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { DatabaseManager } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'

describe('DomainStore task, review and project behavior', () => {
  let manager: DatabaseManager
  let dates: FixedDateProvider
  let store: DomainStore

  beforeEach(() => {
    manager = new DatabaseManager(':memory:')
    dates = new FixedDateProvider('2026-09-02', Date.UTC(2026, 8, 2, 1))
    store = new DomainStore(manager, dates)
  })

  afterEach(() => manager.close())

  it('derives planning, today, calendar and quadrants from one task row', () => {
    const created = store.createTask({ title: 'single source' }).value
    expect(store.getPlanningSnapshot().map((task) => task.id)).toContain(created.id)
    expect(store.getTodaySnapshot().dueToday).toHaveLength(0)
    expect(store.getQuadrantSnapshot().quadrants.Q4.map((task) => task.id)).not.toContain(created.id)
    expect(store.getCalendarRange('2026-09-02', '2026-09-02').days[0]?.items).toHaveLength(0)

    const scheduled = store.setTaskSchedule({ id: created.id, expectedVersion: created.version, plannedOn: '2026-09-02' }).value
    expect(store.getPlanningSnapshot().map((task) => task.id)).not.toContain(created.id)
    expect(store.getTodaySnapshot().dueToday.map((task) => task.id)).toEqual([created.id])
    expect(store.getCalendarRange('2026-09-02', '2026-09-02').days[0]?.items).toHaveLength(1)

    dates.setNowUtcMs(dates.nowUtcMs() + 1)
    const done = store.changeTaskStatus({ id: scheduled.id, expectedVersion: scheduled.version, status: 'DONE' }).value
    expect(done.completedOn).toBe('2026-09-02')
    expect(store.getTodaySnapshot().completedToday.map((task) => task.id)).toEqual([created.id])
    expect(store.getQuadrantSnapshot().quadrants.Q4).toHaveLength(0)
    expect(store.getCalendarRange('2026-09-02', '2026-09-02').days[0]?.items).toHaveLength(1)
    expect(store.getTaskDetail(created.id).history.map((event) => event.kind)).toEqual(['SCHEDULE', 'STATUS'])
  })

  it('keeps parents out of unassigned while only leaf tasks remain executable', () => {
    const parent = store.createTask({ title: 'coarse project item' }).value
    const child = store.createChildTask({
      title: 'today action',
      parentId: parent.id,
      parentExpectedVersion: parent.version,
      plannedOn: '2026-09-02'
    }).value
    expect(store.getPlanningSnapshot()).toHaveLength(0)
    expect(store.getTodaySnapshot().dueToday.map((task) => task.id)).toEqual([child.id])
    expect(store.getQuadrantSnapshot().quadrants.Q4.map((task) => task.id)).toEqual([child.id])
    expect(store.getCalendarRange('2026-09-02', '2026-09-02').days[0]?.items).toHaveLength(1)
    expect(store.getTaskDetail(parent.id).isExecutable).toBe(false)
  })

  it('requires a fact-bound token to close a parent with open children and never cascades', () => {
    const parent = store.createTask({ title: 'parent' }).value
    const child = store.createChildTask({ title: 'child', parentId: parent.id, parentExpectedVersion: parent.version }).value
    let token = ''
    expect(() => {
      try {
        store.changeTaskStatus({ id: parent.id, expectedVersion: parent.version, status: 'DONE' })
      } catch (error) {
        token = String((error as DomainError).details?.confirmationToken)
        throw error
      }
    }).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }))
    const result = store.changeTaskStatus({
      id: parent.id,
      expectedVersion: parent.version,
      status: 'DONE',
      confirmationToken: token
    }).value
    expect(result.status).toBe('DONE')
    expect(store.getTaskDetail(child.id).status).toBe('TODO')
  })

  it('shows yesterday final outcomes and all older unfinished work without moving dates', () => {
    const old = store.createTask({ title: 'old', plannedOn: '2026-08-20' }).value
    const yesterday = store.createTask({ title: 'finished yesterday', plannedOn: '2026-09-01' }).value
    dates.setToday('2026-09-01')
    dates.setNowUtcMs(Date.UTC(2026, 8, 1, 12))
    store.changeTaskStatus({ id: yesterday.id, expectedVersion: yesterday.version, status: 'DONE' })
    dates.setToday('2026-09-02')
    dates.setNowUtcMs(Date.UTC(2026, 8, 2, 1))
    const review = store.getMorningReviewSnapshot()
    expect(review.yesterdayOutcomes.map((item) => item.task.id)).toEqual([yesterday.id])
    expect(review.overdue.map((task) => task.id)).toEqual([old.id])
    expect(store.getTaskDetail(old.id).plannedOn).toBe('2026-08-20')
  })

  it('blocks project completion until all tasks and enabled series are explicitly handled', () => {
    const project = store.createProject({ name: 'release' }).value
    const task = store.createTask({ title: 'ship', projectId: project.id }).value
    expect(() => store.changeProjectStatus({ id: project.id, expectedVersion: project.version, status: 'COMPLETED' })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_HAS_OPEN_TASKS' })
    )
    store.changeTaskStatus({ id: task.id, expectedVersion: task.version, status: 'DONE' })
    const projectAfterTask = store.getProjectDetail(project.id)
    const series = store.createRecurrenceSeries({
      title: 'follow up',
      projectId: project.id,
      startOn: '2026-09-03',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    expect(() =>
      store.changeProjectStatus({ id: project.id, expectedVersion: projectAfterTask.version, status: 'COMPLETED' })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_HAS_ACTIVE_SERIES' }))
    store.setRecurrenceEnabledFromDate({
      id: series.id,
      expectedVersion: series.version,
      effectiveOn: '2026-09-02',
      enabled: false
    })
    const completed = store.changeProjectStatus({
      id: project.id,
      expectedVersion: projectAfterTask.version,
      status: 'COMPLETED'
    }).value
    expect(completed.status).toBe('COMPLETED')
    expect(() => store.createTask({ title: 'forbidden', projectId: project.id })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_COMPLETED' })
    )
  })

  it('deletes projects and goals without deleting their linked work', () => {
    const goal = store.createGoal({ name: '长期方向' }).value
    const project = store.createProject({ name: '交付项目', goalId: goal.id }).value
    const parent = store.createTask({ title: '父工作', projectId: project.id }).value
    const child = store.createChildTask({ title: '子工作', parentId: parent.id, parentExpectedVersion: parent.version }).value
    const series = store.createRecurrenceSeries({
      title: '每日跟进',
      projectId: project.id,
      startOn: '2026-09-02',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value

    store.removeProject({ id: project.id, expectedVersion: project.version })
    expect(() => store.getProjectDetail(project.id)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(store.getTaskDetail(parent.id).project).toBeNull()
    expect(store.getTaskDetail(child.id).project).toBeNull()
    expect(store.getTaskDetail(child.id).parent?.id).toBe(parent.id)
    expect(store.getRecurrenceSeries(series.id).project).toBeNull()
    expect(manager.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(manager.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_rule_immutable_update', 'trg_task_validate_update')").all()).toHaveLength(2)

    const remainingProject = store.createProject({ name: '保留项目', goalId: goal.id }).value
    store.removeGoal({ id: goal.id, expectedVersion: store.getGoalDetail(goal.id).version })
    expect(() => store.getGoalDetail(goal.id)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(store.getProjectDetail(remainingProject.id).goal).toBeNull()
  })
})
