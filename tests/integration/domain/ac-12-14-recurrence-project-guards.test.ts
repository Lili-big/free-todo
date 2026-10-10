import { DomainError } from '../../../src/main/domain/errors'
import { createDomainTestContext, type DomainTestContext } from './test-context'

describe('AC-12 ~ AC-14 recurrence identity and project guards', () => {
  let context: DomainTestContext

  beforeEach(() => {
    context = createDomainTestContext('2026-01-30')
  })

  afterEach(() => context.manager.close())

  it('AC-12 materializes daily, weekly and monthly occurrences with inclusive and month-end rules', () => {
    const { store, dates } = context
    const daily = store.createRecurrenceSeries({
      title: '每日',
      startOn: '2026-01-01',
      endOn: '2026-02-02',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const weekly = store.createRecurrenceSeries({
      title: '每周五',
      startOn: '2026-01-30',
      endOn: '2026-02-13',
      pattern: { kind: 'WEEKLY', weekdays: [5], monthlyDay: null }
    }).value
    const monthly = store.createRecurrenceSeries({
      title: '每月31日',
      startOn: '2026-01-30',
      endOn: '2026-04-30',
      pattern: { kind: 'MONTHLY', weekdays: [], monthlyDay: 31 }
    }).value

    dates.setToday('2026-04-30')
    dates.setNowUtcMs(Date.UTC(2026, 3, 30))
    store.reconcile()
    const tasks = store.listTasks({ pageSize: 500 }).items
    const occurrences = (seriesId: string): string[] =>
      tasks
        .filter((task) => task.recurrence?.seriesId === seriesId)
        .map((task) => task.recurrence!.originalOccurrenceOn)
        .sort()

    expect(occurrences(daily.id)).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
    expect(occurrences(weekly.id)).toEqual(['2026-01-30', '2026-02-06', '2026-02-13'])
    expect(occurrences(monthly.id)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
    expect(occurrences(daily.id)).not.toContain('2026-01-29')
    expect(new Set(occurrences(monthly.id)).size).toBe(4)
  })

  it('AC-13 keeps future browsing read-only and permanently occupies an acted-on occurrence identity', () => {
    const { store, dates, manager } = context
    dates.setToday('2026-09-01')
    dates.setNowUtcMs(Date.UTC(2026, 8, 1))
    let series = store.createRecurrenceSeries({
      title: '每日阅读',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    store.reconcile()
    const beforeCount = store.listTasks().total
    const beforeRevision = manager.metadata.revision
    const firstRead = store.getCalendarRange('2026-09-02', '2026-09-05')
    const secondRead = store.getCalendarRange('2026-09-02', '2026-09-05')
    const projections = firstRead.days.flatMap((day) => day.items).filter((item) => item.kind === 'PROJECTED_OCCURRENCE')
    expect(projections).toHaveLength(4)
    expect(secondRead).toEqual(firstRead)
    expect(store.listTasks().total).toBe(beforeCount)
    expect(manager.metadata.revision).toBe(beforeRevision)

    const target = projections.find((item) => item.originalOccurrenceOn === '2026-09-03')
    expect(target).toBeDefined()
    const exception = store.applyProjectedOccurrence({
      seriesId: target!.seriesId,
      originalOccurrenceOn: target!.originalOccurrenceOn,
      expectedSeriesRowVersion: target!.expectedSeriesRowVersion,
      appliedRuleVersionId: target!.appliedRuleVersionId,
      action: { kind: 'CANCEL' }
    }).value
    expect(exception.status).toBe('CANCELLED')
    expect(exception.recurrence).toEqual({
      seriesId: series.id,
      originalOccurrenceOn: '2026-09-03',
      isException: true
    })
    expect(store.listTasks().total).toBe(beforeCount + 1)
    expect(
      store
        .getCalendarRange('2026-09-03', '2026-09-03')
        .days.flatMap((day) => day.items)
        .some((item) => item.kind === 'PROJECTED_OCCURRENCE')
    ).toBe(false)

    series = store.updateRecurrenceFromDate({
      id: series.id,
      expectedVersion: series.version,
      effectiveOn: '2026-09-02',
      pattern: { kind: 'WEEKLY', weekdays: [7], monthlyDay: null }
    }).value
    expect(store.getTaskDetail(exception.id).recurrence?.isException).toBe(true)
    const stopped = store.setRecurrenceEnabledFromDate({
      id: series.id,
      expectedVersion: series.version,
      effectiveOn: '2026-09-04',
      enabled: false
    }).value
    expect(stopped.version).toBeGreaterThan(series.version)
    const futureAfterStop = store
      .getCalendarRange('2026-09-04', '2026-09-30')
      .days.flatMap((day) => day.items)
      .filter((item) => item.kind === 'PROJECTED_OCCURRENCE' && item.seriesId === series.id)
    expect(futureAfterStop).toHaveLength(0)
    expect(store.getTaskDetail(exception.id).status).toBe('CANCELLED')
  })

  it('AC-14 enforces tree-wide project moves and both project completion blockers', () => {
    const { store, manager, dates } = context
    dates.setToday('2026-09-02')
    const firstProject = store.createProject({ name: '项目A' }).value
    const secondProject = store.createProject({ name: '项目B' }).value
    const parent = store.createTask({ title: '父任务', projectId: firstProject.id }).value
    const child = store.createChildTask({ title: '子任务', parentId: parent.id, parentExpectedVersion: parent.version }).value
    expect(child.project?.id).toBe(firstProject.id)
    expect(() => store.moveTaskTree({ id: child.id, expectedVersion: child.version, projectId: secondProject.id })).toThrowError(
      expect.objectContaining({ code: 'PARENT_PROJECT_MISMATCH' })
    )
    expect(() =>
      manager.immediate((database) => database.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(secondProject.id, child.id))
    ).toThrow()

    let token = ''
    try {
      store.moveTaskTree({ id: parent.id, expectedVersion: parent.version, projectId: secondProject.id })
      throw new Error('expected confirmation')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      token = String((error as DomainError).details?.confirmationToken)
    }
    const moved = store.moveTaskTree({
      id: parent.id,
      expectedVersion: parent.version,
      projectId: secondProject.id,
      confirmationToken: token
    }).value
    expect(moved.project?.id).toBe(secondProject.id)
    expect(moved.children[0]?.project?.id).toBe(secondProject.id)
    expect(() =>
      store.changeProjectStatus({ id: secondProject.id, expectedVersion: secondProject.version, status: 'COMPLETED' })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_HAS_OPEN_TASKS' }))

    const movedChild = moved.children[0]!
    store.changeTaskStatus({ id: movedChild.id, expectedVersion: movedChild.version, status: 'DONE' })
    store.changeTaskStatus({ id: moved.id, expectedVersion: moved.version, status: 'DONE' })
    const series = store.createRecurrenceSeries({
      title: '项目内重复行动',
      projectId: secondProject.id,
      startOn: '2026-09-03',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    expect(() =>
      store.changeProjectStatus({ id: secondProject.id, expectedVersion: secondProject.version, status: 'COMPLETED' })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_HAS_ACTIVE_SERIES' }))
    store.setRecurrenceEnabledFromDate({
      id: series.id,
      expectedVersion: series.version,
      effectiveOn: '2026-09-02',
      enabled: false
    })
    const completedProject = store.changeProjectStatus({
      id: secondProject.id,
      expectedVersion: secondProject.version,
      status: 'COMPLETED'
    }).value
    expect(completedProject.status).toBe('COMPLETED')
    expect(() => store.createTask({ title: '不允许的待办', projectId: secondProject.id })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_COMPLETED' })
    )
    const doneChild = store.getTaskDetail(child.id)
    expect(() => store.changeTaskStatus({ id: doneChild.id, expectedVersion: doneChild.version, status: 'TODO' })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_COMPLETED' })
    )
    expect(() =>
      store.createRecurrenceSeries({
        title: '不允许的系列',
        projectId: secondProject.id,
        startOn: '2026-09-10',
        pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
      })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_COMPLETED' }))
  })
})
