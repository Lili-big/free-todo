import { createDomainTestContext, taskIds } from './test-context'

describe('任务开始与完成日期的归属', () => {
  const context = createDomainTestContext()
  afterAll(() => context.manager.close())

  it('只填完成日期时仅在完成日进入今日；区间包含首尾且不包含外部日期', () => {
    const { store, dates } = context
    const single = store.createTask({ title: '单日任务', plannedOn: '2026-09-04' }).value
    const ranged = store.createTask({ title: '跨日任务', plannedStartOn: '2026-09-02', plannedOn: '2026-09-04' }).value
    const startOnly = store.createTask({ title: '仅有开始时间', plannedStartOn: '2026-09-02' }).value
    for (const [date, expected] of [
      ['2026-09-01', []], ['2026-09-02', [ranged.id]], ['2026-09-03', [ranged.id]],
      ['2026-09-04', [single.id, ranged.id]], ['2026-09-05', []]
    ] as const) {
      dates.setToday(date)
      expect(taskIds(store.getTodaySnapshot().dueToday)).toEqual([...expected].sort())
      expect(taskIds(store.getMorningReviewSnapshot().dueToday)).toEqual([...expected].sort())
    }
    expect(taskIds(store.getPlanningSnapshot())).toContain(startOnly.id)
    expect(taskIds(store.getTodaySnapshot().overdue)).toEqual([single.id, ranged.id].sort())
    const days = store.getCalendarRange('2026-09-01', '2026-09-05').days
    expect(days.flatMap((day) => day.items.filter((item) => item.kind === 'TASK').map((item) => ({ date: day.date, id: item.task.id })))).toEqual(expect.arrayContaining([
      { date: '2026-09-04', id: single.id }, { date: '2026-09-04', id: ranged.id }
    ]))
    expect(days.filter((day) => day.date !== '2026-09-04').flatMap((day) => day.items)).toEqual([])
  })

  it('区间中的任务完成后停止显示，恢复待办后重新归入当天', () => {
    const { store, dates } = context
    dates.setToday('2026-09-03')
    const task = store.createTask({ title: '提前完成', plannedStartOn: '2026-09-02', plannedOn: '2026-09-08' }).value
    const done = store.changeTaskStatus({ id: task.id, expectedVersion: task.version, status: 'DONE' }).value
    expect(taskIds(store.getTodaySnapshot().dueToday)).not.toContain(task.id)
    expect(taskIds(store.getTodaySnapshot().completedToday)).toContain(task.id)
    store.changeTaskStatus({ id: task.id, expectedVersion: done.version, status: 'TODO' })
    expect(taskIds(store.getTodaySnapshot().dueToday)).toContain(task.id)
  })

  it('开始时间不能晚于完成时间；调整区间与改期历史原子保存', () => {
    const { store } = context
    expect(() => store.createTask({ title: '错误日期', plannedStartOn: '2026-09-04', plannedOn: '2026-09-02' })).toThrow('计划开始时间不能晚于计划完成时间')
    const task = store.createTask({ title: '修改区间', plannedStartOn: '2026-09-02', plannedOn: '2026-09-04' }).value
    expect(() => store.setTaskSchedule({ id: task.id, expectedVersion: task.version, plannedOn: '2026-09-01' })).toThrow('计划开始时间不能晚于计划完成时间')
    expect(store.getTaskDetail(task.id)).toMatchObject({ version: task.version, plannedStartOn: '2026-09-02', plannedOn: '2026-09-04', history: [] })
    const updated = store.setTaskSchedule({ id: task.id, expectedVersion: task.version, plannedStartOn: '2026-09-03', plannedOn: '2026-09-06' }).value
    expect(updated.history[0]).toMatchObject({ oldValue: '2026-09-04', newValue: '2026-09-06', oldPlannedStartOn: '2026-09-02', newPlannedStartOn: '2026-09-03' })
    const endOnlyChange = store.setTaskSchedule({ id: task.id, expectedVersion: updated.version, plannedOn: '2026-09-07' }).value
    expect(endOnlyChange.plannedStartOn).toBe('2026-09-03')
    expect(() => store.setTaskSchedule({ id: task.id, expectedVersion: updated.version, plannedOn: '2026-09-09' })).toThrow()
  })

  it('重复实例设置区间只影响本次，保留发生身份且不改变之后的实例', () => {
    const isolated = createDomainTestContext('2026-09-03')
    try {
      const { store, dates } = isolated
      const series = store.createRecurrenceSeries({ title: '每日事项', startOn: '2026-09-03', endOn: '2026-09-06', pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null } }).value
      const instance = store.getTodaySnapshot().dueToday.find((task) => task.recurrence?.seriesId === series.id)!
      const updated = store.setTaskSchedule({ id: instance.id, expectedVersion: instance.version, plannedStartOn: '2026-09-03', plannedOn: '2026-09-05' }).value
      expect(updated.recurrence).toMatchObject({ originalOccurrenceOn: '2026-09-03', isException: true })
      dates.setToday('2026-09-04')
      const today = store.getTodaySnapshot().dueToday.filter((task) => task.recurrence?.seriesId === series.id)
      expect(today).toHaveLength(2)
      expect(today.find((task) => task.id !== instance.id)).toMatchObject({ plannedOn: '2026-09-04', plannedStartOn: null })
    } finally { isolated.manager.close() }
  })
})
