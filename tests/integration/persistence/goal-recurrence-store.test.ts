import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { DatabaseManager } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'

describe('DomainStore goals and recurrence', () => {
  let manager: DatabaseManager
  let dates: FixedDateProvider
  let store: DomainStore

  beforeEach(() => {
    manager = new DatabaseManager(':memory:')
    dates = new FixedDateProvider('2026-09-01', Date.UTC(2026, 8, 1))
    store = new DomainStore(manager, dates)
  })

  afterEach(() => manager.close())

  it('moves only active expired goals to review during an idempotent cross-day sweep', () => {
    const category = store.createGoalCategory(' 工作 ').value
    const goal = store.createGoal({
      name: '发布产品',
      categoryId: category.id,
      priority: 'P0',
      period: { kind: 'CUSTOM', startOn: '2026-08-01', endOn: '2026-09-01' }
    }).value
    expect(goal.status).toBe('ACTIVE')
    const before = manager.metadata.revision
    dates.setToday('2026-09-02')
    dates.setNowUtcMs(Date.UTC(2026, 8, 2))
    const first = store.reconcile()
    expect(first.value.localDate).toBe('2026-09-02')
    expect(first.change.revision).toBeGreaterThan(before)
    expect(store.getGoalDetail(goal.id).status).toBe('REVIEW_REQUIRED')
    const revision = manager.metadata.revision
    store.reconcile()
    expect(manager.metadata.revision).toBe(revision)
  })

  it('backfills every elapsed daily occurrence once and retains original identity after rescheduling', () => {
    const series = store.createRecurrenceSeries({
      title: '每日检查',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    dates.setToday('2026-09-04')
    dates.setNowUtcMs(Date.UTC(2026, 8, 4))
    store.reconcile()
    let instances = store.listTasks().items.filter((task) => task.recurrence?.seriesId === series.id)
    expect(instances.map((task) => task.recurrence?.originalOccurrenceOn).sort()).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04'
    ])
    const first = instances.find((task) => task.recurrence?.originalOccurrenceOn === '2026-09-01')!
    store.setTaskSchedule({ id: first.id, expectedVersion: first.version, plannedOn: '2026-09-10' })
    store.reconcile()
    instances = store.listTasks().items.filter((task) => task.recurrence?.seriesId === series.id)
    expect(instances).toHaveLength(4)
    expect(store.getTaskDetail(first.id).recurrence).toEqual({
      seriesId: series.id,
      originalOccurrenceOn: '2026-09-01',
      isException: true
    })
  })

  it('projects future occurrences without writes and materializes the first action as a permanent exception', () => {
    const series = store.createRecurrenceSeries({
      title: '阅读',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const beforeCount = store.listTasks().total
    const calendar = store.getCalendarRange('2026-09-02', '2026-09-05')
    const projected = calendar.days.flatMap((day) => day.items).filter((item) => item.kind === 'PROJECTED_OCCURRENCE')
    expect(projected).toHaveLength(4)
    expect(store.listTasks().total).toBe(beforeCount)

    const target = projected[1]!
    if (target.kind !== 'PROJECTED_OCCURRENCE') throw new Error('expected projection')
    const completed = store.applyProjectedOccurrence({
      seriesId: target.seriesId,
      originalOccurrenceOn: target.originalOccurrenceOn,
      expectedSeriesRowVersion: target.expectedSeriesRowVersion,
      appliedRuleVersionId: target.appliedRuleVersionId,
      action: { kind: 'COMPLETE' }
    }).value
    expect(completed.status).toBe('DONE')
    expect(completed.completedOn).toBe('2026-09-01')
    expect(completed.recurrence?.isException).toBe(true)
    const after = store.getCalendarRange('2026-09-02', '2026-09-05')
    const occurrenceKeys = after.days
      .flatMap((day) => day.items)
      .filter((item) => item.kind === 'PROJECTED_OCCURRENCE')
      .map((item) => item.occurrenceKey)
    expect(occurrenceKeys).not.toContain(target.occurrenceKey)
  })

  it('clamps a monthly 31 rule to each month end', () => {
    dates.setToday('2026-01-30')
    const series = store.createRecurrenceSeries({
      title: '月末',
      startOn: '2026-01-30',
      pattern: { kind: 'MONTHLY', weekdays: [], monthlyDay: 31 }
    }).value
    dates.setToday('2026-04-30')
    dates.setNowUtcMs(Date.UTC(2026, 3, 30))
    store.reconcile()
    const datesFound = store
      .listTasks({ pageSize: 500 })
      .items.filter((task) => task.recurrence?.seriesId === series.id)
      .map((task) => task.recurrence?.originalOccurrenceOn)
      .sort()
    expect(datesFound).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('recalculates pristine instances from the effective day while preserving user exceptions', () => {
    const pristineSeries = store.createRecurrenceSeries({
      title: 'pristine',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const pristine = store.listTasks().items.find((task) => task.recurrence?.seriesId === pristineSeries.id)!
    store.updateRecurrenceFromDate({
      id: pristineSeries.id,
      expectedVersion: pristineSeries.version,
      effectiveOn: '2026-09-01',
      pattern: { kind: 'WEEKLY', weekdays: [3], monthlyDay: null }
    })
    expect(store.listTasks().items.some((task) => task.id === pristine.id)).toBe(false)

    const exceptionSeries = store.createRecurrenceSeries({
      title: 'exception',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const exception = store.listTasks().items.find((task) => task.recurrence?.seriesId === exceptionSeries.id)!
    const edited = store.updateTaskContent({
      id: exception.id,
      expectedVersion: exception.version,
      title: 'my private edit'
    }).value
    store.updateRecurrenceFromDate({
      id: exceptionSeries.id,
      expectedVersion: exceptionSeries.version,
      effectiveOn: '2026-09-01',
      pattern: { kind: 'WEEKLY', weekdays: [3], monthlyDay: null }
    })
    expect(store.getTaskDetail(edited.id).title).toBe('my private edit')
    expect(store.getTaskDetail(edited.id).recurrence?.isException).toBe(true)
  })

  it('rejects cross-series applied rule versions and overlapping active timelines at the database boundary', () => {
    const first = store.createRecurrenceSeries({
      title: 'A',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const second = store.createRecurrenceSeries({
      title: 'B',
      startOn: '2026-09-01',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    }).value
    const secondVersion = manager.connection
      .prepare('SELECT id FROM recurrence_rule_versions WHERE series_id = ?')
      .get(second.id) as { id: string }
    expect(() =>
      manager.immediate((database) => {
        database
          .prepare(
            `INSERT INTO tasks(id,title,planned_on,status,is_important,is_urgent,recurrence_series_id,applied_rule_version_id,
              original_occurrence_on,is_recurrence_exception,created_on,created_at_utc,updated_at_utc)
             VALUES ('cross','x','2026-10-01','TODO',0,0,?,?, '2026-10-01',1,'2026-09-01',1,1)`
          )
          .run(first.id, secondVersion.id)
      })
    ).toThrow()

    const firstVersion = manager.connection
      .prepare('SELECT * FROM recurrence_rule_versions WHERE series_id = ?')
      .get(first.id) as Record<string, unknown>
    expect(() =>
      manager.connection
        .prepare(
          `INSERT INTO recurrence_rule_versions(
            id,series_id,effective_from_on,effective_to_on_exclusive,timeline_active,enabled,title,notes,project_id,
            is_important,is_urgent,rule_kind,rule_start_on,rule_end_on,weekday_mask,monthly_day,created_at_utc,retired_at_utc)
           VALUES ('overlap',@series_id,@effective_from_on,@effective_to_on_exclusive,1,@enabled,@title,@notes,@project_id,
             @is_important,@is_urgent,@rule_kind,@rule_start_on,@rule_end_on,@weekday_mask,@monthly_day,@created_at_utc,NULL)`
        )
        .run(firstVersion)
    ).toThrow()
  })
})
