import type { RecurrencePatternDto } from '@shared/types'
import { DomainError } from './errors'
import { LocalDate } from './local-date'

export interface RecurrenceRule {
  enabled: boolean
  effectiveFromOn: string
  effectiveToOnExclusive: string | null
  ruleStartOn: string
  ruleEndOn: string | null
  pattern: RecurrencePatternDto
}

export function validateRecurrencePattern(pattern: RecurrencePatternDto): RecurrencePatternDto {
  if (pattern.kind === 'DAILY') {
    if (pattern.weekdays.length !== 0 || pattern.monthlyDay !== null) invalidRule()
    return { kind: 'DAILY', weekdays: [], monthlyDay: null }
  }
  if (pattern.kind === 'WEEKLY') {
    const weekdays = [...new Set(pattern.weekdays)].sort((a, b) => a - b)
    if (pattern.monthlyDay !== null || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      invalidRule()
    }
    return { kind: 'WEEKLY', weekdays, monthlyDay: null }
  }
  if (pattern.kind === 'MONTHLY') {
    if (
      pattern.weekdays.length !== 0 ||
      pattern.monthlyDay === null ||
      !Number.isInteger(pattern.monthlyDay) ||
      pattern.monthlyDay < 1 ||
      pattern.monthlyDay > 31
    ) {
      invalidRule()
    }
    return { kind: 'MONTHLY', weekdays: [], monthlyDay: pattern.monthlyDay }
  }
  return invalidRule()
}

export function weekdayMask(pattern: RecurrencePatternDto): number {
  const normalized = validateRecurrencePattern(pattern)
  if (normalized.kind !== 'WEEKLY') return 0
  return normalized.weekdays.reduce((mask, weekday) => mask | (1 << (weekday - 1)), 0)
}

export function patternFromColumns(kind: 'DAILY' | 'WEEKLY' | 'MONTHLY', mask: number, monthlyDay: number | null): RecurrencePatternDto {
  if (kind === 'DAILY') return { kind, weekdays: [], monthlyDay: null }
  if (kind === 'MONTHLY') return { kind, weekdays: [], monthlyDay }
  const weekdays: number[] = []
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    if ((mask & (1 << (weekday - 1))) !== 0) weekdays.push(weekday)
  }
  return { kind, weekdays, monthlyDay: null }
}

export function occursOn(seriesCreatedOn: string, rule: RecurrenceRule, dateValue: string): boolean {
  const date = parseRuleDate(dateValue)
  const created = parseRuleDate(seriesCreatedOn)
  const effectiveFrom = parseRuleDate(rule.effectiveFromOn)
  const effectiveTo = rule.effectiveToOnExclusive === null ? null : parseRuleDate(rule.effectiveToOnExclusive)
  const starts = parseRuleDate(rule.ruleStartOn)
  const ends = rule.ruleEndOn === null ? null : parseRuleDate(rule.ruleEndOn)
  const pattern = validateRecurrencePattern(rule.pattern)

  if (!rule.enabled || date.isBefore(created) || date.isBefore(effectiveFrom) || date.isBefore(starts)) return false
  if (effectiveTo !== null && !date.isBefore(effectiveTo)) return false
  if (ends !== null && date.isAfter(ends)) return false

  if (pattern.kind === 'DAILY') return true
  if (pattern.kind === 'WEEKLY') return pattern.weekdays.includes(date.isoWeekday())
  return date.day === Math.min(pattern.monthlyDay as number, LocalDate.daysInMonth(date.year, date.month))
}

export function enumerateOccurrences(
  seriesCreatedOn: string,
  rules: RecurrenceRule[],
  startOn: string,
  endOn: string
): Array<{ occurrenceOn: string; ruleIndex: number }> {
  const start = parseRuleDate(startOn)
  const end = parseRuleDate(endOn)
  if (start.isAfter(end)) return []
  const result: Array<{ occurrenceOn: string; ruleIndex: number }> = []
  for (let cursor = start; !cursor.isAfter(end); cursor = cursor.addDays(1)) {
    const value = cursor.toString()
    const index = rules.findIndex((rule) => occursOn(seriesCreatedOn, rule, value))
    if (index >= 0) result.push({ occurrenceOn: value, ruleIndex: index })
  }
  return result
}

function parseRuleDate(value: string): LocalDate {
  try {
    return LocalDate.parse(value)
  } catch {
    throw new DomainError('RECURRENCE_RULE_INVALID', '重复规则包含无效日期')
  }
}

function invalidRule(): never {
  throw new DomainError('RECURRENCE_RULE_INVALID', '重复规则无效')
}
