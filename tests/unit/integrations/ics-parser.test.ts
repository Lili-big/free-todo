import { parseIcsEvents } from '@main/integrations/wecom-calendar/ics-parser'

describe('ICS event parser', () => {
  it('parses all-day events with an exclusive end date', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:all-day-1\r
DTSTART;VALUE=DATE:20260904\r
DTEND;VALUE=DATE:20260906\r
SUMMARY:客户会议\r
LOCATION:上海\\,会议室 A\r
END:VEVENT\r
END:VCALENDAR`)

    expect(events).toEqual([expect.objectContaining({
      uid: 'all-day-1',
      title: '客户会议',
      start: '2026-09-04',
      end: '2026-09-06',
      allDay: true,
      location: '上海,会议室 A'
    })])
  })

  it('normalizes UTC values and preserves floating/TZID wall-clock values', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:utc
DTSTART:20260904T013000Z
DTEND:20260904T023000Z
SUMMARY:UTC event
END:VEVENT
BEGIN:VEVENT
UID:local
DTSTART;TZID=Asia/Shanghai:20260904T093000
DTEND;TZID=Asia/Shanghai:20260904T103000
SUMMARY:Local event
END:VEVENT
END:VCALENDAR`)

    expect(events[0]).toEqual(expect.objectContaining({
      start: '2026-09-04T01:30:00.000Z',
      end: '2026-09-04T02:30:00.000Z',
      timeZone: 'UTC'
    }))
    expect(events[1]).toEqual(expect.objectContaining({
      start: '2026-09-04T09:30:00',
      end: '2026-09-04T10:30:00',
      timeZone: 'Asia/Shanghai'
    }))
  })

  it('keeps cross-day bounds, unfolds text and tolerates recurring payloads', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=Asia/Shanghai:20260904T230000
DTEND;TZID=Asia/Shanghai:20260905T010000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:跨日
 会议
END:VEVENT
BEGIN:VEVENT
UID:series-1
RECURRENCE-ID;TZID=Asia/Shanghai:20260905T230000
DTSTART;TZID=Asia/Shanghai:20260905T220000
DURATION:PT2H
SUMMARY:调整后的实例
END:VEVENT
END:VCALENDAR`)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual(expect.objectContaining({
      title: '跨日会议',
      start: '2026-09-04T23:00:00',
      end: '2026-09-05T01:00:00'
    }))
    expect(events[1]?.recurrenceId).toBe('20260905T230000')
    expect(events[1]?.end).toBe('2026-09-06T00:00:00')
  })

  it('expands daily rules and replaces one occurrence with an Enterprise WeChat exception', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=Asia/Shanghai:20260904T230000
DTEND;TZID=Asia/Shanghai:20260905T010000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:跨日会议
END:VEVENT
BEGIN:VEVENT
UID:series-1
RECURRENCE-ID;TZID=Asia/Shanghai:20260905T230000
DTSTART;TZID=Asia/Shanghai:20260905T220000
DURATION:PT2H
SUMMARY:调整后的实例
END:VEVENT
END:VCALENDAR`, { startOn: '2026-09-04', endOn: '2026-09-07' })

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.start)).toEqual([
      '2026-09-04T23:00:00',
      '2026-09-05T22:00:00',
      '2026-09-06T23:00:00'
    ])
    expect(events[1]).toEqual(expect.objectContaining({ title: '调整后的实例', end: '2026-09-06T00:00:00' }))
  })

  it('honors weekly weekdays, exclusions, additions and a cancelled detached occurrence', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:team-evening
DTSTART;TZID=Asia/Shanghai:20260901T173000
DTEND;TZID=Asia/Shanghai:20260901T180000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20260911T235959Z
EXDATE;TZID=Asia/Shanghai:20260903T173000
RDATE;TZID=Asia/Shanghai:20260905T173000
SUMMARY:团队夕会
END:VEVENT
BEGIN:VEVENT
UID:team-evening
RECURRENCE-ID;TZID=Asia/Shanghai:20260908T173000
STATUS:CANCELLED
SUMMARY:团队夕会
END:VEVENT
END:VCALENDAR`, { startOn: '2026-09-01', endOn: '2026-09-11' })

    const visible = events.filter((event) => !event.cancelled)
    expect(visible.map((event) => event.start)).toEqual([
      '2026-09-01T17:30:00', '2026-09-02T17:30:00', '2026-09-04T17:30:00',
      '2026-09-05T17:30:00', '2026-09-07T17:30:00', '2026-09-09T17:30:00',
      '2026-09-10T17:30:00', '2026-09-11T17:30:00'
    ])
    expect(events.filter((event) => event.cancelled)).toHaveLength(1)
  })

  it('supports monthly ordinal weekday rules within the requested range', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:monthly-review
DTSTART;TZID=Asia/Shanghai:20260907T133000
DTEND;TZID=Asia/Shanghai:20260907T143000
RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3
SUMMARY:月度评审
END:VEVENT
END:VCALENDAR`, { startOn: '2026-09-01', endOn: '2026-11-30' })

    expect(events.map((event) => event.start)).toEqual([
      '2026-09-07T13:30:00',
      '2026-10-05T13:30:00',
      '2026-11-02T13:30:00'
    ])
  })
})
