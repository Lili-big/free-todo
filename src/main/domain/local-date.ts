/**
 * A calendar date in the proleptic Gregorian calendar.
 *
 * Business dates are deliberately independent from timestamps and time zones.
 * The constructor is private so every instance is known to be a real date.
 */
export class LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number

  private constructor(year: number, month: number, day: number) {
    this.year = year
    this.month = month
    this.day = day
  }

  static of(year: number, month: number, day: number): LocalDate {
    if (!Number.isInteger(year) || year < 1 || year > 9999) {
      throw new LocalDateError('year must be an integer between 1 and 9999')
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new LocalDateError('month must be an integer between 1 and 12')
    }
    const maximumDay = LocalDate.daysInMonth(year, month)
    if (!Number.isInteger(day) || day < 1 || day > maximumDay) {
      throw new LocalDateError(`day must be between 1 and ${maximumDay}`)
    }
    return new LocalDate(year, month, day)
  }

  static parse(value: string): LocalDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) {
      throw new LocalDateError('date must use YYYY-MM-DD')
    }
    return LocalDate.of(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  static tryParse(value: string): LocalDate | null {
    try {
      return LocalDate.parse(value)
    } catch {
      return null
    }
  }

  static fromLocalDateTime(value: Date): LocalDate {
    if (Number.isNaN(value.getTime())) {
      throw new LocalDateError('invalid Date')
    }
    return LocalDate.of(value.getFullYear(), value.getMonth() + 1, value.getDate())
  }

  static isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  }

  static daysInMonth(year: number, month: number): number {
    if (!Number.isInteger(year) || year < 1 || year > 9999) {
      throw new LocalDateError('year must be an integer between 1 and 9999')
    }
    const monthDays = [31, LocalDate.isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    const result = monthDays[month - 1]
    if (result === undefined) {
      throw new LocalDateError('month must be an integer between 1 and 12')
    }
    return result
  }

  compareTo(other: LocalDate): number {
    return Math.sign(this.toEpochDay() - other.toEpochDay())
  }

  isBefore(other: LocalDate): boolean {
    return this.compareTo(other) < 0
  }

  isAfter(other: LocalDate): boolean {
    return this.compareTo(other) > 0
  }

  equals(other: LocalDate): boolean {
    return this.year === other.year && this.month === other.month && this.day === other.day
  }

  addDays(days: number): LocalDate {
    if (!Number.isInteger(days)) throw new LocalDateError('days must be an integer')
    return LocalDate.fromEpochDay(this.toEpochDay() + days)
  }

  startOfMonth(): LocalDate {
    return LocalDate.of(this.year, this.month, 1)
  }

  endOfMonth(): LocalDate {
    return LocalDate.of(this.year, this.month, LocalDate.daysInMonth(this.year, this.month))
  }

  startOfQuarter(): LocalDate {
    return LocalDate.of(this.year, Math.floor((this.month - 1) / 3) * 3 + 1, 1)
  }

  endOfQuarter(): LocalDate {
    const endMonth = Math.floor((this.month - 1) / 3) * 3 + 3
    return LocalDate.of(this.year, endMonth, LocalDate.daysInMonth(this.year, endMonth))
  }

  startOfYear(): LocalDate {
    return LocalDate.of(this.year, 1, 1)
  }

  endOfYear(): LocalDate {
    return LocalDate.of(this.year, 12, 31)
  }

  /** ISO-8601 weekday: Monday = 1, Sunday = 7. */
  isoWeekday(): number {
    return floorMod(this.toEpochDay() + 3, 7) + 1
  }

  startOfIsoWeek(): LocalDate {
    return this.addDays(1 - this.isoWeekday())
  }

  toString(): string {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`
  }

  toJSON(): string {
    return this.toString()
  }

  /** Days relative to 1970-01-01, using a pure civil-date algorithm. */
  private toEpochDay(): number {
    let year = this.year
    const month = this.month
    year -= month <= 2 ? 1 : 0
    const era = Math.floor(year / 400)
    const yearOfEra = year - era * 400
    const shiftedMonth = month + (month > 2 ? -3 : 9)
    const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + this.day - 1
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
    return era * 146097 + dayOfEra - 719468
  }

  private static fromEpochDay(epochDay: number): LocalDate {
    let serial = epochDay + 719468
    const era = Math.floor(serial / 146097)
    const dayOfEra = serial - era * 146097
    const yearOfEra = Math.floor(
      (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365
    )
    let year = yearOfEra + era * 400
    const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
    const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153)
    const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1
    const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9)
    year += month <= 2 ? 1 : 0
    return LocalDate.of(year, month, day)
  }
}

function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

export class LocalDateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalDateError'
  }
}

export interface DateProvider {
  today(): LocalDate
  nowUtcMs(): number
}

export class SystemDateProvider implements DateProvider {
  today(): LocalDate {
    return LocalDate.fromLocalDateTime(new Date())
  }

  nowUtcMs(): number {
    return Date.now()
  }
}

export class FixedDateProvider implements DateProvider {
  private currentDate: LocalDate
  private currentUtcMs: number

  constructor(date: string | LocalDate, utcMs = 0) {
    this.currentDate = typeof date === 'string' ? LocalDate.parse(date) : date
    this.currentUtcMs = utcMs
  }

  today(): LocalDate {
    return this.currentDate
  }

  nowUtcMs(): number {
    return this.currentUtcMs
  }

  setToday(date: string | LocalDate): void {
    this.currentDate = typeof date === 'string' ? LocalDate.parse(date) : date
  }

  setNowUtcMs(utcMs: number): void {
    this.currentUtcMs = utcMs
  }
}

export function assertLocalDate(value: string, fieldName = 'date'): string {
  try {
    return LocalDate.parse(value).toString()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid date'
    throw new LocalDateError(`${fieldName}: ${message}`)
  }
}
