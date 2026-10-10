import { DomainError } from '../../../src/main/domain/errors'
import { monthPeriod, quarterPeriod, validateAndNormalizeGoalPeriod, yearPeriod } from '../../../src/main/domain/goal-period'

describe('goal periods', () => {
  it('builds exact natural boundaries', () => {
    expect(monthPeriod(2024, 2)).toEqual({ kind: 'MONTH', startOn: '2024-02-01', endOn: '2024-02-29' })
    expect(quarterPeriod(2026, 3)).toEqual({ kind: 'QUARTER', startOn: '2026-07-01', endOn: '2026-09-30' })
    expect(yearPeriod(2026)).toEqual({ kind: 'YEAR', startOn: '2026-01-01', endOn: '2026-12-31' })
  })

  it('rejects a partial natural period or reversed custom period', () => {
    expect(() =>
      validateAndNormalizeGoalPeriod({ kind: 'MONTH', startOn: '2026-09-02', endOn: '2026-09-30' })
    ).toThrow(DomainError)
    expect(() =>
      validateAndNormalizeGoalPeriod({ kind: 'CUSTOM', startOn: '2026-10-01', endOn: '2026-09-30' })
    ).toThrow(DomainError)
  })

  it('normalizes an omitted period to NONE', () => {
    expect(validateAndNormalizeGoalPeriod(undefined)).toEqual({ kind: 'NONE', startOn: null, endOn: null })
  })
})
