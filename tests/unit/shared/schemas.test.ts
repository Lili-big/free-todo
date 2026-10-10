import { isValidLocalDate, localDateSchema, recurrencePatternSchema } from '../../../src/shared/schemas'

describe('shared schemas', () => {
  it.each([
    ['2024-02-29', true],
    ['2023-02-29', false],
    ['2026-09-02', true],
    ['2026-9-2', false],
    ['0000-01-01', false],
    ['2026-13-01', false],
    ['2026-04-31', false]
  ])('validates LocalDate %s', (value, expected) => {
    expect(isValidLocalDate(value)).toBe(expected)
    expect(localDateSchema.safeParse(value).success).toBe(expected)
  })

  it('normalizes weekly days and rejects an empty weekly rule', () => {
    const parsed = recurrencePatternSchema.parse({ kind: 'WEEKLY', weekdays: [5, 1, 5], monthlyDay: null })
    expect(parsed.weekdays).toEqual([1, 5])
    expect(recurrencePatternSchema.safeParse({ kind: 'WEEKLY', weekdays: [], monthlyDay: null }).success).toBe(false)
  })

  it('accepts monthly day 31 and rejects day 32', () => {
    expect(recurrencePatternSchema.safeParse({ kind: 'MONTHLY', weekdays: [], monthlyDay: 31 }).success).toBe(true)
    expect(recurrencePatternSchema.safeParse({ kind: 'MONTHLY', weekdays: [], monthlyDay: 32 }).success).toBe(false)
  })
})

