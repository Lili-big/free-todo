import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { DatabaseManager } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'

export interface DomainTestContext {
  manager: DatabaseManager
  dates: FixedDateProvider
  store: DomainStore
}

export function createDomainTestContext(date = '2026-09-02'): DomainTestContext {
  const manager = new DatabaseManager(':memory:')
  const dates = new FixedDateProvider(date, Date.UTC(2026, 8, 2, 8))
  return { manager, dates, store: new DomainStore(manager, dates) }
}

export function taskIds(items: ReadonlyArray<{ id: string }>): string[] {
  return items.map((item) => item.id).sort()
}

export function realCalendarTaskIds(days: ReadonlyArray<{ items: ReadonlyArray<{ kind: string; task?: { id: string } }> }>): string[] {
  return days.flatMap((day) => day.items).flatMap((item) => (item.kind === 'TASK' && item.task ? [item.task.id] : [])).sort()
}
