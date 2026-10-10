import { FixedDateProvider, LocalDate, LocalDateError } from '../../../src/main/domain/local-date'

describe('LocalDate', () => {
  it('strictly rejects malformed and impossible dates', () => {
    expect(() => LocalDate.parse('2026-2-01')).toThrow(LocalDateError)
    expect(() => LocalDate.parse('2025-02-29')).toThrow(LocalDateError)
    expect(() => LocalDate.parse('2024-02-30')).toThrow(LocalDateError)
    expect(LocalDate.parse('2024-02-29').toString()).toBe('2024-02-29')
  })

  it('adds calendar days across leap years without a timestamp or 24-hour assumption', () => {
    expect(LocalDate.parse('2024-02-28').addDays(1).toString()).toBe('2024-02-29')
    expect(LocalDate.parse('2024-02-29').addDays(1).toString()).toBe('2024-03-01')
    expect(LocalDate.parse('2025-01-01').addDays(-1).toString()).toBe('2024-12-31')
  })

  it('calculates ISO weekdays and week boundaries', () => {
    expect(LocalDate.parse('2026-09-02').isoWeekday()).toBe(3)
    expect(LocalDate.parse('2026-09-06').isoWeekday()).toBe(7)
    expect(LocalDate.parse('2026-09-06').startOfIsoWeek().toString()).toBe('2026-08-31')
  })

  it('calculates month, quarter and year boundaries', () => {
    const date = LocalDate.parse('2024-02-10')
    expect(date.startOfMonth().toString()).toBe('2024-02-01')
    expect(date.endOfMonth().toString()).toBe('2024-02-29')
    expect(date.startOfQuarter().toString()).toBe('2024-01-01')
    expect(date.endOfQuarter().toString()).toBe('2024-03-31')
    expect(date.endOfYear().toString()).toBe('2024-12-31')
  })

  it('makes the date and audit clock injectable', () => {
    const provider = new FixedDateProvider('2026-09-02', 123)
    expect(provider.today().toString()).toBe('2026-09-02')
    expect(provider.nowUtcMs()).toBe(123)
    provider.setToday('2026-09-03')
    provider.setNowUtcMs(456)
    expect(provider.today().toString()).toBe('2026-09-03')
    expect(provider.nowUtcMs()).toBe(456)
  })
})
