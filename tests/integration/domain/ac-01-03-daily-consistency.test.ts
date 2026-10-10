import { createDomainTestContext, realCalendarTaskIds, taskIds, type DomainTestContext } from './test-context'

describe('AC-01 ~ AC-03 daily views use one task source', () => {
  let context: DomainTestContext

  beforeEach(() => {
    context = createDomainTestContext()
  })

  afterEach(() => context.manager.close())

  it('AC-01 moves one task between planning, today and future calendar without copying it', () => {
    const { store } = context
    const created = store.createTask({ title: '未排期任务' }).value

    expect(taskIds(store.getPlanningSnapshot())).toEqual([created.id])
    expect(store.getTodaySnapshot().dueToday).toHaveLength(0)
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q4)).toEqual([])
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-02', '2026-09-02').days)).toEqual([])
    expect(store.listTasks().total).toBe(1)

    const todayTask = store.setTaskSchedule({
      id: created.id,
      expectedVersion: created.version,
      plannedOn: '2026-09-02'
    }).value
    expect(store.getPlanningSnapshot()).toHaveLength(0)
    expect(taskIds(store.getTodaySnapshot().dueToday)).toEqual([created.id])
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-02', '2026-09-02').days)).toEqual([created.id])
    expect(store.listTasks().total).toBe(1)

    store.setTaskSchedule({ id: todayTask.id, expectedVersion: todayTask.version, plannedOn: '2026-09-10' })
    expect(store.getTodaySnapshot().dueToday).toHaveLength(0)
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-10', '2026-09-10').days)).toEqual([created.id])
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q4)).toEqual([created.id])
    expect(store.listTasks().total).toBe(1)
  })

  it('AC-02 review is repeatable and all five legacy actions produce the prescribed unique destination', () => {
    const { dates, manager, store } = context
    dates.setToday('2026-09-01')
    dates.setNowUtcMs(Date.UTC(2026, 8, 1, 9))
    const yesterdayDone = store.createTask({ title: '昨日完成', plannedOn: '2026-09-01' }).value
    const yesterdayCancelled = store.createTask({ title: '昨日取消', plannedOn: '2026-09-01' }).value
    store.changeTaskStatus({ id: yesterdayDone.id, expectedVersion: yesterdayDone.version, status: 'DONE' })
    store.changeTaskStatus({ id: yesterdayCancelled.id, expectedVersion: yesterdayCancelled.version, status: 'CANCELLED' })

    const complete = store.createTask({ title: '遗留-完成', plannedOn: '2026-08-20' }).value
    const moveToday = store.createTask({ title: '遗留-今天', plannedOn: '2026-08-21' }).value
    const moveFuture = store.createTask({ title: '遗留-未来', plannedOn: '2026-08-22' }).value
    const clearDate = store.createTask({ title: '遗留-待分配', plannedOn: '2026-08-23' }).value
    const cancel = store.createTask({ title: '遗留-取消', plannedOn: '2026-08-24' }).value
    const planning = store.createTask({ title: '无日期' }).value
    const dueToday = store.createTask({ title: '今日新任务', plannedOn: '2026-09-02' }).value

    dates.setToday('2026-09-02')
    dates.setNowUtcMs(Date.UTC(2026, 8, 2, 7))
    const beforeRows = (manager.connection.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count
    const first = store.getMorningReviewSnapshot()
    const second = store.getMorningReviewSnapshot()
    expect(taskIds(first.yesterdayOutcomes.map((outcome) => outcome.task))).toEqual(taskIds([yesterdayDone, yesterdayCancelled]))
    expect(taskIds(first.overdue)).toEqual(taskIds([complete, moveToday, moveFuture, clearDate, cancel]))
    expect(taskIds(first.unscheduled)).toEqual([planning.id])
    expect(taskIds(first.dueToday)).toEqual([dueToday.id])
    expect(second).toEqual(first)
    expect((manager.connection.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count).toBe(beforeRows)

    store.changeTaskStatus({ id: complete.id, expectedVersion: complete.version, status: 'DONE' })
    store.setTaskSchedule({ id: moveToday.id, expectedVersion: moveToday.version, plannedOn: '2026-09-02' })
    store.setTaskSchedule({ id: moveFuture.id, expectedVersion: moveFuture.version, plannedOn: '2026-09-10' })
    store.setTaskSchedule({ id: clearDate.id, expectedVersion: clearDate.version, plannedOn: null })
    store.changeTaskStatus({ id: cancel.id, expectedVersion: cancel.version, status: 'CANCELLED' })

    const after = store.getTodaySnapshot()
    expect(after.overdue).toHaveLength(0)
    expect(taskIds(after.dueToday)).toEqual(taskIds([moveToday, dueToday]))
    expect(taskIds(after.completedToday)).toEqual([complete.id])
    expect(taskIds(store.getPlanningSnapshot())).toEqual(taskIds([planning, clearDate]))
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-10', '2026-09-10').days)).toEqual([moveFuture.id])
    expect(store.getTaskDetail(cancel.id).status).toBe('CANCELLED')
    expect((manager.connection.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count).toBe(beforeRows)
  })

  it('AC-03 preserves the real task id, completion day and original calendar position', () => {
    const { store, manager } = context
    const task = store.createTask({ title: '同一任务', plannedOn: '2026-09-01' }).value
    const before = store.getMorningReviewSnapshot()
    store.getTodaySnapshot()
    store.getMorningReviewSnapshot()
    expect(before.overdue[0]?.id).toBe(task.id)
    expect(store.listTasks().total).toBe(1)

    const completed = store.changeTaskStatus({ id: task.id, expectedVersion: task.version, status: 'DONE' }).value
    expect(completed.id).toBe(task.id)
    expect(completed.completedOn).toBe('2026-09-02')
    expect(taskIds(store.getTodaySnapshot().completedToday)).toEqual([task.id])
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-01', '2026-09-01').days)).toEqual([task.id])
    expect((manager.connection.prepare('SELECT count(*) AS count FROM tasks').get() as { count: number }).count).toBe(1)
  })
})
