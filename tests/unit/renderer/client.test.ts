// @vitest-environment jsdom
import type { TodoDesktopApi } from '../../../src/shared/api'
import { normalizeTask, todoClient } from '../../../src/renderer/client'

const dto = {
  id: 'task-1', version: 7, title: '每日复盘', notes: null, status: 'TODO' as const,
  plannedOn: '2026-09-02', completedOn: null, cancelledOn: null,
  important: true, urgent: false, project: null, parent: null,
  hasChildren: false, isExecutable: true, pendingChildCount: 0, isOverdue: false,
  recurrence: { seriesId: 'series-1', originalOccurrenceOn: '2026-09-02', isException: false },
  createdAtUtc: '2026-09-02T00:00:00.000Z', updatedAtUtc: '2026-09-02T00:00:00.000Z'
}

describe('renderer API normalization', () => {
  it('读取共享 Task DTO 中嵌套的重复身份与 version', () => {
    expect(normalizeTask(dto)).toMatchObject({
      rowVersion: 7,
      recurrenceSeriesId: 'series-1',
      originalOccurrenceOn: '2026-09-02'
    })
  })

  it('严格按共享 TodaySnapshot 的 dueToday 与 reviewCardState 归一化', async () => {
    window.todoApi = {
      today: { getSnapshot: vi.fn(async () => ({ ok: true, data: {
        localDate: '2026-09-02', reviewCardState: 'FINISHED', overdue: [], dueToday: [dto], completedToday: [],
        counts: { overdue: 0, dueToday: 1, completedToday: 0 }
      } })) }
    } as unknown as TodoDesktopApi

    await expect(todoClient.today.snapshot()).resolves.toMatchObject({
      today: '2026-09-02', showReviewCard: false,
      todayTasks: [{ id: 'task-1', title: '每日复盘' }]
    })
  })

  it('挂接已有父任务时传递项目迁移确认令牌', async () => {
    const changeParent = vi.fn(async () => ({ ok: true, data: { value: dto } }))
    window.todoApi = {
      tasks: { changeParent }
    } as unknown as TodoDesktopApi

    const task = normalizeTask(dto)
    await todoClient.tasks.attachParent(task, '8ed2c3d5-d8f4-4ca6-9c77-09157b6c3f72', 'confirm-token')

    expect(changeParent).toHaveBeenCalledWith({
      id: 'task-1',
      expectedVersion: 7,
      parentId: '8ed2c3d5-d8f4-4ca6-9c77-09157b6c3f72',
      confirmationToken: 'confirm-token'
    })
  })

  it('将企业微信连接、同步与日程范围保持在独立只读通道', async () => {
    const getStatus = vi.fn(async () => ({ ok: true as const, data: {
      source: 'WECOM_CALDAV' as const, connected: true, syncing: false,
      serverHost: 'caldav.wecom.work', accountHint: 'zh***',
      lastAttemptAtUtc: '2026-09-03T00:00:00.000Z', lastSuccessAtUtc: '2026-09-03T00:01:00.000Z',
      lastErrorCode: null, cachedEventCount: 2,
      cachedRangeStartOn: '2026-08-31', cachedRangeEndOn: '2026-10-04'
    } }))
    const connect = vi.fn(async () => getStatus())
    const sync = vi.fn(async () => ({ ok: true as const, data: {
      status: (await getStatus()).data,
      receivedEventCount: 2
    } }))
    const getRange = vi.fn(async () => ({ ok: true as const, data: {
      startOn: '2026-09-01', endOn: '2026-09-30', items: [{
        kind: 'EXTERNAL_EVENT' as const, id: 'event-1', source: 'WECOM_CALDAV' as const,
        title: '客户会议', start: '2026-09-03T09:30:00', end: '2026-09-03T10:00:00',
        allDay: false, location: '会议室 A', timeZone: 'Asia/Shanghai'
      }]
    } }))
    window.todoApi = {
      wecomCalendar: { getStatus, connect, disconnect: vi.fn(), sync, getRange }
    } as unknown as TodoDesktopApi

    await expect(todoClient.wecomCalendar.status()).resolves.toMatchObject({ connected: true, cachedEventCount: 2 })
    await todoClient.wecomCalendar.connect({ server: 'https://caldav.wecom.work', account: 'zhangsan', password: 'secret' })
    await expect(todoClient.wecomCalendar.sync('2026-09-01', '2026-09-30')).resolves.toMatchObject({ receivedEventCount: 2 })
    await expect(todoClient.wecomCalendar.range('2026-09-01', '2026-09-30')).resolves.toEqual([expect.objectContaining({
      kind: 'EXTERNAL_EVENT', source: 'WECOM_CALDAV', title: '客户会议', location: '会议室 A'
    })])

    expect(connect).toHaveBeenCalledWith({ server: 'https://caldav.wecom.work', account: 'zhangsan', password: 'secret' })
    expect(sync).toHaveBeenCalledWith({ startOn: '2026-09-01', endOn: '2026-09-30' })
    expect(getRange).toHaveBeenCalledWith({ startOn: '2026-09-01', endOn: '2026-09-30' })
  })
})
