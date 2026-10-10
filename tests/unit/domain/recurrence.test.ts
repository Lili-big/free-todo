import { DomainError } from '../../../src/main/domain/errors'
import { enumerateOccurrences, occursOn, validateRecurrencePattern, weekdayMask } from '../../../src/main/domain/recurrence'

const base = {
  enabled: true,
  effectiveFromOn: '2026-01-01',
  effectiveToOnExclusive: null,
  ruleStartOn: '2026-01-01',
  ruleEndOn: null
}

describe('recurrence domain rules', () => {
  it('supports daily and inclusive end boundaries', () => {
    const rule = { ...base, ruleEndOn: '2026-01-03', pattern: { kind: 'DAILY' as const, weekdays: [], monthlyDay: null } }
    expect(occursOn('2026-01-01', rule, '2026-01-01')).toBe(true)
    expect(occursOn('2026-01-01', rule, '2026-01-03')).toBe(true)
    expect(occursOn('2026-01-01', rule, '2026-01-04')).toBe(false)
  })

  it('uses ISO weekdays and a stable bit mask', () => {
    const pattern = { kind: 'WEEKLY' as const, weekdays: [5, 1, 5], monthlyDay: null }
    expect(validateRecurrencePattern(pattern).weekdays).toEqual([1, 5])
    expect(weekdayMask(pattern)).toBe(17)
    const rule = { ...base, pattern }
    expect(occursOn('2026-01-01', rule, '2026-09-07')).toBe(true)
    expect(occursOn('2026-01-01', rule, '2026-09-08')).toBe(false)
  })

  it('clamps monthly days independently to the end of every month', () => {
    const rule = { ...base, pattern: { kind: 'MONTHLY' as const, weekdays: [], monthlyDay: 31 } }
    expect(occursOn('2026-01-01', rule, '2026-02-28')).toBe(true)
    expect(occursOn('2026-01-01', rule, '2026-03-31')).toBe(true)
    expect(occursOn('2026-01-01', rule, '2026-04-30')).toBe(true)
    expect(
      enumerateOccurrences('2026-01-01', [rule], '2026-02-01', '2026-04-30').map((item) => item.occurrenceOn)
    ).toEqual(['2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('never backfills before series creation and honors half-open version boundaries', () => {
    const rule = {
      ...base,
      effectiveToOnExclusive: '2026-02-01',
      pattern: { kind: 'DAILY' as const, weekdays: [], monthlyDay: null }
    }
    expect(occursOn('2026-01-15', rule, '2026-01-14')).toBe(false)
    expect(occursOn('2026-01-15', rule, '2026-01-31')).toBe(true)
    expect(occursOn('2026-01-15', rule, '2026-02-01')).toBe(false)
  })

  it('rejects malformed patterns', () => {
    expect(() => validateRecurrencePattern({ kind: 'WEEKLY', weekdays: [], monthlyDay: null })).toThrow(DomainError)
    expect(() => validateRecurrencePattern({ kind: 'MONTHLY', weekdays: [], monthlyDay: 32 })).toThrow(DomainError)
  })
})
