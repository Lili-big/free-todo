import { DomainError } from '../../../src/main/domain/errors'
import { createDomainTestContext, realCalendarTaskIds, taskIds, type DomainTestContext } from './test-context'

describe('AC-07 ~ AC-11 goals, quadrants and calendar', () => {
  let context: DomainTestContext

  beforeEach(() => {
    context = createDomainTestContext()
  })

  afterEach(() => context.manager.close())

  it('category ALL includes uncategorized goals, while category and null select only their own goals', () => {
    const { store } = context
    const work = store.createGoalCategory('工作').value
    const study = store.createGoalCategory('学习').value
    const workGoal = store.createGoal({ name: '工作目标', categoryId: work.id }).value
    const studyGoal = store.createGoal({ name: '学习目标', categoryId: study.id }).value
    const uncategorized = store.createGoal({ name: '无分类目标' }).value
    const allIds = [workGoal.id, studyGoal.id, uncategorized.id].sort()
    expect(store.listGoals({}).map((goal) => goal.id).sort()).toEqual(allIds)
    expect(store.listGoals({ categoryId: undefined }).map((goal) => goal.id).sort()).toEqual(allIds)
    expect(store.listGoals({ categoryId: work.id }).map((goal) => goal.id)).toEqual([workGoal.id])
    expect(store.listGoals({ categoryId: study.id }).map((goal) => goal.id)).toEqual([studyGoal.id])
    expect(store.listGoals({ categoryId: null }).map((goal) => goal.id)).toEqual([uncategorized.id])
  })

  it('AC-07 represents one goal to many projects and replacement through one goal_id', () => {
    const { store } = context
    const firstGoal = store.createGoal({ name: '建立稳定产品体系' }).value
    const secondGoal = store.createGoal({ name: '提升个人产出质量' }).value
    const firstProject = store.createProject({ name: '项目A', goalId: firstGoal.id }).value
    const secondProject = store.createProject({ name: '项目B', goalId: firstGoal.id }).value
    expect(store.getGoalDetail(firstGoal.id).projectCount).toBe(2)
    expect(firstProject.goal?.id).toBe(firstGoal.id)

    const moved = store.updateProject({
      id: firstProject.id,
      expectedVersion: firstProject.version,
      goalId: secondGoal.id
    }).value
    expect(moved.goal?.id).toBe(secondGoal.id)
    expect(store.getGoalDetail(firstGoal.id).projectCount).toBe(1)
    expect(store.getGoalDetail(secondGoal.id).projectCount).toBe(1)

    const independent = store.updateProject({ id: secondProject.id, expectedVersion: secondProject.version, goalId: null }).value
    expect(independent.goal).toBeNull()
    expect(store.getGoalDetail(firstGoal.id).projectCount).toBe(0)
  })

  it('AC-08 sorts category/priority correctly and expires only active goals after the inclusive end day', () => {
    const { store, dates } = context
    dates.setToday('2026-09-01')
    const category = store.createGoalCategory(' 学习 ').value
    const p3 = store.createGoal({ name: 'P3', categoryId: category.id, priority: 'P3' }).value
    const unset = store.createGoal({ name: '未设置', categoryId: category.id }).value
    const ending = store.createGoal({
      name: 'P0',
      categoryId: category.id,
      priority: 'P0',
      period: { kind: 'MONTH', startOn: '2026-09-01', endOn: '2026-09-30' }
    }).value
    const paused = store.createGoal({
      name: '暂停后过期',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    store.changeGoalStatus({ id: paused.id, expectedVersion: paused.version, status: 'PAUSED' })
    expect(store.listGoals({ categoryId: category.id }).map((goal) => goal.id)).toEqual([ending.id, p3.id, unset.id])
    expect(store.getGoalDetail(paused.id).status).toBe('PAUSED')

    dates.setToday('2026-09-02')
    store.reconcile()
    expect(store.getGoalDetail(paused.id).status).toBe('PAUSED')
    const resumed = store.changeGoalStatus({
      id: paused.id,
      expectedVersion: store.getGoalDetail(paused.id).version,
      status: 'ACTIVE'
    }).value
    expect(resumed.status).toBe('REVIEW_REQUIRED')
    expect(store.getGoalDetail(ending.id).status).toBe('ACTIVE')
    expect(store.getGoalDetail(unset.id).status).toBe('ACTIVE')
    expect(() =>
      store.createGoal({
        name: '非完整自然月',
        period: { kind: 'MONTH', startOn: '2026-09-02', endOn: '2026-09-30' }
      })
    ).toThrowError(expect.objectContaining({ code: 'GOAL_PERIOD_INVALID' }))
  })

  it('AC-09 handles all review results without copies or cascading into active projects', () => {
    const { store } = context
    const completedGoal = store.createGoal({
      name: '完成结果',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    const continuedGoal = store.createGoal({
      name: '继续结果',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    const pausedGoal = store.createGoal({
      name: '暂停结果',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    const abandonedGoal = store.createGoal({
      name: '放弃结果',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    const activeProject = store.createProject({ name: '仍在进行', goalId: completedGoal.id }).value
    expect(store.listGoals()).toHaveLength(4)

    let confirmationToken = ''
    try {
      store.changeGoalStatus({ id: completedGoal.id, expectedVersion: completedGoal.version, status: 'COMPLETED' })
      throw new Error('expected confirmation')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      const domain = error as DomainError
      expect(domain.code).toBe('CONFIRMATION_REQUIRED')
      expect(domain.details?.facts).toEqual({ activeProjectCount: 1 })
      confirmationToken = String(domain.details?.confirmationToken)
    }
    store.changeGoalStatus({
      id: completedGoal.id,
      expectedVersion: completedGoal.version,
      status: 'COMPLETED',
      confirmationToken
    })
    store.changeGoalStatus({
      id: continuedGoal.id,
      expectedVersion: continuedGoal.version,
      status: 'ACTIVE',
      period: { kind: 'CUSTOM', startOn: '2026-09-02', endOn: '2026-12-31' }
    })
    store.changeGoalStatus({ id: pausedGoal.id, expectedVersion: pausedGoal.version, status: 'PAUSED' })
    store.changeGoalStatus({ id: abandonedGoal.id, expectedVersion: abandonedGoal.version, status: 'ABANDONED' })

    expect(store.getGoalDetail(completedGoal.id).status).toBe('COMPLETED')
    expect(store.getGoalDetail(continuedGoal.id).status).toBe('ACTIVE')
    expect(store.getGoalDetail(pausedGoal.id).status).toBe('PAUSED')
    expect(store.getGoalDetail(abandonedGoal.id).status).toBe('ABANDONED')
    expect(store.getProjectDetail(activeProject.id).status).toBe('ACTIVE')
    expect(store.listGoals()).toHaveLength(4)
  })

  it('AC-10 maps the two manual booleans to exactly one quadrant and always excludes parents', () => {
    const { store } = context
    let task = store.createTask({ title: '象限任务', plannedOn: '2026-09-02' }).value
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q4)).toEqual([task.id])
    task = store.updateTaskContent({ id: task.id, expectedVersion: task.version, important: true }).value
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q2)).toEqual([task.id])
    task = store.updateTaskContent({ id: task.id, expectedVersion: task.version, urgent: true }).value
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q1)).toEqual([task.id])
    task = store.updateTaskContent({ id: task.id, expectedVersion: task.version, important: false }).value
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q3)).toEqual([task.id])
    task = store.setTaskSchedule({ id: task.id, expectedVersion: task.version, plannedOn: '2026-08-01' }).value
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q3)).toEqual([task.id])

    const child = store.createChildTask({ title: '叶子', plannedOn: '2026-09-03', parentId: task.id, parentExpectedVersion: task.version }).value
    const quadrants = store.getQuadrantSnapshot().quadrants
    expect(Object.values(quadrants).flat().some((item) => item.id === task.id)).toBe(false)
    expect(taskIds(quadrants.Q4)).toEqual([child.id])
    store.setTaskSchedule({ id: child.id, expectedVersion: child.version, plannedOn: null })
    expect(Object.values(store.getQuadrantSnapshot().quadrants).flat()).toHaveLength(0)
  })

  it('AC-11 keeps week/month reads identical, read-only and updates both after one reschedule', () => {
    const { store, manager } = context
    let ordinary = store.createTask({ title: '普通', plannedOn: '2026-09-02' }).value
    const done = store.createTask({ title: '已完成', plannedOn: '2026-09-03' }).value
    const cancelled = store.createTask({ title: '已取消', plannedOn: '2026-09-04' }).value
    const parent = store.createTask({ title: '有日期父任务', plannedOn: '2026-09-05' }).value
    const child = store.createChildTask({
      title: '有日期子任务',
      parentId: parent.id,
      parentExpectedVersion: parent.version,
      plannedOn: '2026-09-05'
    }).value
    store.changeTaskStatus({ id: done.id, expectedVersion: done.version, status: 'DONE' })
    store.changeTaskStatus({ id: cancelled.id, expectedVersion: cancelled.version, status: 'CANCELLED' })
    store.reconcile()
    const revision = manager.metadata.revision

    const weekIds = realCalendarTaskIds(store.getCalendarRange('2026-08-31', '2026-09-06').days)
    const monthIds = realCalendarTaskIds(store.getCalendarRange('2026-09-01', '2026-09-30').days)
    expect(weekIds).toEqual(taskIds([ordinary, done, child]))
    expect(monthIds).toEqual(weekIds)
    expect(weekIds).not.toContain(parent.id)
    expect(weekIds).not.toContain(cancelled.id)
    expect(manager.metadata.revision).toBe(revision)

    ordinary = store.setTaskSchedule({ id: ordinary.id, expectedVersion: ordinary.version, plannedOn: '2026-09-06' }).value
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-02', '2026-09-02').days)).not.toContain(ordinary.id)
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-06', '2026-09-06').days)).toEqual([ordinary.id])
    expect(store.getTaskDetail(ordinary.id).history.some((event) => event.kind === 'SCHEDULE')).toBe(true)
  })
})
