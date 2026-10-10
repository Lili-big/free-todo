import rrulePackage from 'rrule'

const { rrulestr } = rrulePackage

export interface ParsedIcsEvent {
  uid: string
  recurrenceId: string | null
  title: string
  start: string
  end: string
  allDay: boolean
  location: string | null
  timeZone: string | null
  cancelled: boolean
}

interface IcsProperty {
  name: string
  parameters: Readonly<Record<string, string>>
  value: string
}

interface ParsedDateValue {
  value: string
  allDay: boolean
  timeZone: string | null
}

export interface IcsExpansionWindow {
  startOn: string
  endOn: string
}

function unfoldLines(ics: string): string[] {
  return ics
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
}

function separatorIndex(line: string): number {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') quoted = !quoted
    if (character === ':' && !quoted) return index
  }
  return -1
}

function parseProperty(line: string): IcsProperty | null {
  const separator = separatorIndex(line)
  if (separator < 1) return null
  const left = line.slice(0, separator)
  const value = line.slice(separator + 1)
  const segments = left.split(';')
  const name = (segments.shift() ?? '').trim().toUpperCase()
  if (!name) return null
  const parameters: Record<string, string> = {}
  for (const segment of segments) {
    const equals = segment.indexOf('=')
    if (equals < 1) continue
    const key = segment.slice(0, equals).trim().toUpperCase()
    const rawValue = segment.slice(equals + 1).trim()
    parameters[key] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue
  }
  return { name, parameters, value }
}

function decodeIcsText(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '\\' || index + 1 >= value.length) {
      output += character
      continue
    }
    const escaped = value[index + 1]
    index += 1
    if (escaped === 'n' || escaped === 'N') output += '\n'
    else output += escaped
  }
  return output
}

function dateOnly(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!match) return null
  if (!validDateParts(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0)) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

function validDateParts(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return false
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59)))
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
}

function parseDateValue(property: IcsProperty): ParsedDateValue | null {
  const raw = property.value.trim()
  const localDate = dateOnly(raw)
  if (property.parameters.VALUE?.toUpperCase() === 'DATE' || localDate) {
    return localDate ? { value: localDate, allDay: true, timeZone: null } : null
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/.exec(raw)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? '0')
  if (!validDateParts(year, month, day, hour, minute, second)) return null

  const datePart = `${match[1]}-${match[2]}-${match[3]}`
  const timePart = `${match[4]}:${match[5]}:${String(Math.min(second, 59)).padStart(2, '0')}`
  const zoneSuffix = match[7]
  if (zoneSuffix === 'Z') {
    return {
      value: new Date(`${datePart}T${timePart}Z`).toISOString(),
      allDay: false,
      timeZone: 'UTC'
    }
  }
  if (zoneSuffix) {
    const isoOffset = `${zoneSuffix.slice(0, 3)}:${zoneSuffix.slice(3)}`
    return {
      value: new Date(`${datePart}T${timePart}${isoOffset}`).toISOString(),
      allDay: false,
      timeZone: isoOffset
    }
  }
  return {
    value: `${datePart}T${timePart}`,
    allDay: false,
    timeZone: property.parameters.TZID ?? null
  }
}

function addDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'))
    .join('-')
}

function addDuration(start: ParsedDateValue, duration: string): string | null {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(duration.trim())
  if (!match) return null
  const days = Number(match[1] ?? '0') * 7 + Number(match[2] ?? '0')
  const milliseconds = (((days * 24 + Number(match[3] ?? '0')) * 60 + Number(match[4] ?? '0')) * 60 + Number(match[5] ?? '0')) * 1000
  if (start.allDay) return addDays(start.value, Math.max(1, Math.ceil(milliseconds / 86_400_000)))
  const floating = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(start.value)
  if (floating) {
    const value = new Date(Date.UTC(
      Number(floating[1]),
      Number(floating[2]) - 1,
      Number(floating[3]),
      Number(floating[4]),
      Number(floating[5]),
      Number(floating[6])
    ) + milliseconds)
    const date = `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
    const time = `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`
    return `${date}T${time}`
  }
  const parsed = new Date(start.value)
  if (!Number.isFinite(parsed.getTime())) return null
  const result = new Date(parsed.getTime() + milliseconds)
  return result.toISOString()
}

function parseEvent(properties: IcsProperty[]): ParsedIcsEvent | null {
  const values = new Map<string, IcsProperty[]>()
  for (const property of properties) {
    const entries = values.get(property.name) ?? []
    entries.push(property)
    values.set(property.name, entries)
  }
  const first = (name: string): IcsProperty | undefined => values.get(name)?.[0]
  const recurrenceProperty = first('RECURRENCE-ID')
  const startProperty = first('DTSTART') ?? recurrenceProperty
  if (!startProperty) return null
  const start = parseDateValue(startProperty)
  if (!start) return null

  const endProperty = first('DTEND')
  const parsedEnd = endProperty ? parseDateValue(endProperty) : null
  const duration = first('DURATION')?.value
  let end = parsedEnd?.value ?? (duration ? addDuration(start, duration) : null)
  if (!end) end = start.allDay ? addDays(start.value, 1) : start.value

  const summary = first('SUMMARY')?.value ?? ''
  const location = first('LOCATION')?.value
  const recurrenceId = recurrenceProperty?.value ?? null
  const uid = first('UID')?.value.trim() || `${start.value}\u0000${summary}`
  return {
    uid,
    recurrenceId,
    title: decodeIcsText(summary).trim(),
    start: start.value,
    end,
    allDay: start.allDay,
    location: location === undefined ? null : decodeIcsText(location).trim() || null,
    timeZone: start.timeZone,
    cancelled: first('STATUS')?.value.trim().toUpperCase() === 'CANCELLED'
  }
}

function firstProperty(properties: IcsProperty[], name: string): IcsProperty | undefined {
  return properties.find((property) => property.name === name)
}

function propertiesNamed(properties: IcsProperty[], name: string): IcsProperty[] {
  return properties.filter((property) => property.name === name)
}

function pseudoDate(property: IcsProperty): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(property.value.trim())
  if (!match) return null
  const value = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] ?? '0'), Number(match[5] ?? '0'), Number(match[6] ?? '0')
  ))
  return Number.isNaN(value.getTime()) ? null : value
}

function basicDate(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function basicTime(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}:${String(value.getUTCSeconds()).padStart(2, '0')}`
}

function occurrenceValue(value: Date, template: IcsProperty, allDay: boolean): string {
  const date = basicDate(value)
  if (allDay) return date
  const wallClock = `${date}T${basicTime(value)}`
  const raw = template.value.trim()
  if (/Z$/i.test(raw)) return `${wallClock}Z`
  const offset = /([+-])(\d{2})(\d{2})$/.exec(raw)
  if (offset) {
    const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1)
    return new Date(Date.parse(`${wallClock}Z`) - minutes * 60_000).toISOString()
  }
  return wallClock
}

function parsedDurationMs(event: ParsedIcsEvent): number {
  if (event.allDay) {
    return Math.max(0, Date.parse(`${event.end}T00:00:00Z`) - Date.parse(`${event.start}T00:00:00Z`))
  }
  const asMillis = (value: string): number => {
    const candidate = hasExplicitZone(value) ? value : `${value}Z`
    return Date.parse(candidate)
  }
  const start = asMillis(event.start)
  const end = asMillis(event.end)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
}

function dateList(properties: IcsProperty[]): Array<{ value: Date; property: IcsProperty }> {
  const result: Array<{ value: Date; property: IcsProperty }> = []
  for (const property of properties) {
    for (const rawValue of property.value.split(',')) {
      const item = { ...property, value: rawValue.trim() }
      const value = pseudoDate(item)
      if (value) result.push({ value, property: item })
    }
  }
  return result
}

function expansionBounds(window: IcsExpansionWindow, durationMs: number): { after: Date; before: Date } | null {
  const start = Date.parse(`${window.startOn}T00:00:00Z`)
  const end = Date.parse(`${window.endOn}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return {
    after: new Date(start - Math.max(0, durationMs) - 1),
    before: new Date(end + 86_400_000)
  }
}

interface ParsedRecord {
  event: ParsedIcsEvent
  properties: IcsProperty[]
}

function expandRecord(master: ParsedRecord, exceptions: ParsedRecord[], window: IcsExpansionWindow): ParsedIcsEvent[] {
  const startProperty = firstProperty(master.properties, 'DTSTART')
  const ruleProperty = firstProperty(master.properties, 'RRULE')
  const rdateProperties = propertiesNamed(master.properties, 'RDATE')
  if (!startProperty || (!ruleProperty && rdateProperties.length === 0)) return [master.event, ...exceptions.map(({ event }) => event)]

  const initial = pseudoDate(startProperty)
  const bounds = expansionBounds(window, parsedDurationMs(master.event))
  if (!initial || !bounds) return [master.event, ...exceptions.map(({ event }) => event)]

  const candidates = new Map<number, Date>()
  if (ruleProperty) {
    const frequency = /(?:^|;)FREQ=([^;]+)/i.exec(ruleProperty.value)?.[1]?.toUpperCase()
    if (frequency && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) {
      try {
        const rule = rrulestr(ruleProperty.value, { dtstart: initial })
        for (const occurrence of rule.between(bounds.after, bounds.before, true).slice(0, 5000)) {
          candidates.set(occurrence.getTime(), occurrence)
        }
      } catch {
        candidates.set(initial.getTime(), initial)
      }
    } else {
      candidates.set(initial.getTime(), initial)
    }
  } else {
    candidates.set(initial.getTime(), initial)
  }
  for (const item of dateList(rdateProperties)) candidates.set(item.value.getTime(), item.value)
  const excluded = new Set(dateList(propertiesNamed(master.properties, 'EXDATE')).map(({ value }) => value.getTime()))

  const exceptionsByRecurrence = new Map<number, ParsedRecord>()
  for (const exception of exceptions) {
    const recurrenceProperty = firstProperty(exception.properties, 'RECURRENCE-ID')
    const recurrence = recurrenceProperty ? pseudoDate(recurrenceProperty) : null
    if (recurrence) exceptionsByRecurrence.set(recurrence.getTime(), exception)
  }

  const output: ParsedIcsEvent[] = []
  const usedExceptions = new Set<ParsedRecord>()
  const durationMs = parsedDurationMs(master.event)
  for (const [key, occurrence] of [...candidates.entries()].sort(([left], [right]) => left - right)) {
    if (excluded.has(key)) continue
    const exception = exceptionsByRecurrence.get(key)
    if (exception) {
      usedExceptions.add(exception)
      output.push(exception.event)
      continue
    }
    output.push({
      ...master.event,
      recurrenceId: `generated:${occurrence.toISOString()}`,
      start: occurrenceValue(occurrence, startProperty, master.event.allDay),
      end: occurrenceValue(new Date(occurrence.getTime() + durationMs), startProperty, master.event.allDay)
    })
  }
  for (const exception of exceptions) {
    if (!usedExceptions.has(exception)) output.push(exception.event)
  }
  return output
}

/**
 * Parses VEVENT fields needed by the application. When a bounded expansion
 * window is supplied, RFC 5545 recurrence rules and detached exceptions are
 * expanded locally because some CalDAV servers return only the raw series.
 */
export function parseIcsEvents(ics: string, window?: IcsExpansionWindow): ParsedIcsEvent[] {
  const records: ParsedRecord[] = []
  let current: IcsProperty[] | null = null
  for (const line of unfoldLines(ics)) {
    const marker = line.trim().toUpperCase()
    if (marker === 'BEGIN:VEVENT') {
      current = []
      continue
    }
    if (marker === 'END:VEVENT') {
      if (current) {
        const event = parseEvent(current)
        if (event) records.push({ event, properties: current })
      }
      current = null
      continue
    }
    if (!current) continue
    const property = parseProperty(line)
    if (property) current.push(property)
  }
  if (!window) return records.map(({ event }) => event)

  const grouped = new Map<string, ParsedRecord[]>()
  for (const record of records) {
    const values = grouped.get(record.event.uid) ?? []
    values.push(record)
    grouped.set(record.event.uid, values)
  }
  const expanded: ParsedIcsEvent[] = []
  for (const values of grouped.values()) {
    const masters = values.filter((record) => !firstProperty(record.properties, 'RECURRENCE-ID'))
    const exceptions = values.filter((record) => firstProperty(record.properties, 'RECURRENCE-ID'))
    if (masters.length === 0) {
      expanded.push(...exceptions.map(({ event }) => event))
      continue
    }
    for (const [index, master] of masters.entries()) {
      expanded.push(...expandRecord(master, index === 0 ? exceptions : [], window))
    }
  }
  return expanded
}
