import { calendarMonthRange, endOfMonth, startOfIsoWeek } from '../../../src/renderer/src/utils/date'

describe('renderer date presentation helpers', () => {
  it('自然月范围按 ISO 周一到周日补齐', () => {
    expect(calendarMonthRange('2026-09-15')).toEqual({ startOn: '2026-08-31', endOn: '2026-10-04' })
  })

  it('闰年与 ISO 周起点稳定', () => {
    expect(endOfMonth('2028-02-12')).toBe('2028-02-29')
    expect(startOfIsoWeek('2026-09-06')).toBe('2026-08-31')
  })
})

