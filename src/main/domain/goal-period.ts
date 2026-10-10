import type { GoalPeriodDto } from '@shared/types'
import { DomainError } from './errors'
import { LocalDate } from './local-date'

export function validateAndNormalizeGoalPeriod(period: GoalPeriodDto | undefined): GoalPeriodDto {
  if (period === undefined || period.kind === 'NONE') {
    return { kind: 'NONE', startOn: null, endOn: null }
  }

  const start = parsePeriodDate(period.startOn)
  const end = parsePeriodDate(period.endOn)
  if (start.isAfter(end)) {
    throw new DomainError('GOAL_PERIOD_INVALID', '目标周期开始日不能晚于结束日')
  }

  if (period.kind === 'MONTH' && (!start.equals(start.startOfMonth()) || !end.equals(start.endOfMonth()))) {
    throw new DomainError('GOAL_PERIOD_INVALID', '月度目标必须使用完整自然月')
  }
  if (period.kind === 'QUARTER' && (!start.equals(start.startOfQuarter()) || !end.equals(start.endOfQuarter()))) {
    throw new DomainError('GOAL_PERIOD_INVALID', '季度目标必须使用完整自然季度')
  }
  if (period.kind === 'YEAR' && (!start.equals(start.startOfYear()) || !end.equals(start.endOfYear()))) {
    throw new DomainError('GOAL_PERIOD_INVALID', '年度目标必须使用完整自然年')
  }

  return { kind: period.kind, startOn: start.toString(), endOn: end.toString() }
}

export function monthPeriod(year: number, month: number): GoalPeriodDto {
  const start = LocalDate.of(year, month, 1)
  return { kind: 'MONTH', startOn: start.toString(), endOn: start.endOfMonth().toString() }
}

export function quarterPeriod(year: number, quarter: number): GoalPeriodDto {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new DomainError('GOAL_PERIOD_INVALID', '季度必须在 1 到 4 之间')
  }
  const start = LocalDate.of(year, (quarter - 1) * 3 + 1, 1)
  return { kind: 'QUARTER', startOn: start.toString(), endOn: start.endOfQuarter().toString() }
}

export function yearPeriod(year: number): GoalPeriodDto {
  const start = LocalDate.of(year, 1, 1)
  return { kind: 'YEAR', startOn: start.toString(), endOn: start.endOfYear().toString() }
}

function parsePeriodDate(value: string): LocalDate {
  try {
    return LocalDate.parse(value)
  } catch {
    throw new DomainError('GOAL_PERIOD_INVALID', '目标周期日期无效')
  }
}
