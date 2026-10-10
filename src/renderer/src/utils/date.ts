import type { LocalDate } from '../../domain'

interface DateParts { year: number; month: number; day: number }

function parts(value: LocalDate): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return { year: 1970, month: 1, day: 1 }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function fromDate(value: Date): LocalDate {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateAtNoon(value: LocalDate): Date {
  const { year, month, day } = parts(value)
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

export function addDays(value: LocalDate, amount: number): LocalDate {
  const date = dateAtNoon(value)
  date.setDate(date.getDate() + amount)
  return fromDate(date)
}

export function addMonths(value: LocalDate, amount: number): LocalDate {
  const { year, month } = parts(value)
  const anchor = new Date(year, month - 1 + amount, 1, 12)
  return fromDate(anchor)
}

export function startOfIsoWeek(value: LocalDate): LocalDate {
  const date = dateAtNoon(value)
  const weekday = date.getDay() || 7
  return addDays(value, 1 - weekday)
}

export function endOfIsoWeek(value: LocalDate): LocalDate {
  return addDays(startOfIsoWeek(value), 6)
}

export function startOfMonth(value: LocalDate): LocalDate {
  const { year, month } = parts(value)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function endOfMonth(value: LocalDate): LocalDate {
  const { year, month } = parts(value)
  return fromDate(new Date(year, month, 0, 12))
}

export function calendarMonthRange(value: LocalDate): { startOn: LocalDate; endOn: LocalDate } {
  return {
    startOn: startOfIsoWeek(startOfMonth(value)),
    endOn: endOfIsoWeek(endOfMonth(value))
  }
}

export function eachDay(startOn: LocalDate, endOn: LocalDate): LocalDate[] {
  const values: LocalDate[] = []
  let current = startOn
  let guard = 0
  while (current <= endOn && guard < 50) {
    values.push(current)
    current = addDays(current, 1)
    guard += 1
  }
  return values
}

export function formatDate(value: LocalDate | null | undefined, options?: { weekday?: boolean; year?: boolean }): string {
  if (!value) return '未排期'
  const { year, month, day } = parts(value)
  const base = options?.year === false ? `${month}月${day}日` : `${year}年${month}月${day}日`
  if (!options?.weekday) return base
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${base} ${names[dateAtNoon(value).getDay()]}`
}

export function monthTitle(value: LocalDate): string {
  const { year, month } = parts(value)
  return `${year} 年 ${month} 月`
}

export function dayNumber(value: LocalDate): number {
  return parts(value).day
}

export function sameMonth(left: LocalDate, right: LocalDate): boolean {
  const a = parts(left)
  const b = parts(right)
  return a.year === b.year && a.month === b.month
}

export function relativeDateLabel(value: LocalDate | null, today: LocalDate): string {
  if (!value) return '待分配'
  if (value === today) return '今天'
  if (value === addDays(today, -1)) return '昨天'
  if (value === addDays(today, 1)) return '明天'
  return formatDate(value, { year: false, weekday: true })
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(timestamp))
}
