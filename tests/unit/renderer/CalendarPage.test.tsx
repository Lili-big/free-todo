// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { TaskComposerProvider } from '../../../src/renderer/src/components/TaskComposer'
import { CalendarPage } from '../../../src/renderer/src/pages/CalendarPage'

const rawTask = (id: string, title: string, plannedOn = '2026-09-03') => ({
  id, version: 1, title, notes: null, status: 'TODO' as const, plannedOn,
  completedOn: null, cancelledOn: null, important: false, urgent: false,
  project: null, parent: null, hasChildren: false, isExecutable: true,
  pendingChildCount: 0, isOverdue: false, recurrence: null,
  createdAtUtc: '2026-09-01T00:00:00.000Z', updatedAtUtc: '2026-09-01T00:00:00.000Z'
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider><TaskComposerProvider today="2026-09-03">{children}</TaskComposerProvider></FeedbackProvider></QueryClientProvider>
}

function installApi(items: unknown[], applyProjectedOccurrence = vi.fn(), externalItems: unknown[] = []) {
  const createTask = vi.fn()
  window.todoApi = {
    calendar: { getRange: vi.fn(async ({ startOn, endOn }) => ({ ok: true as const, data: { startOn, endOn, days: [{ date: '2026-09-03', items }] } })) },
    projects: { list: vi.fn(async () => ({ ok: true as const, data: [] })) },
    tasks: { list: vi.fn(async () => ({ ok: true as const, data: { tasks: [], page: 1, pageSize: 100, total: 0 } })), create: createTask },
    recurrences: { applyProjectedOccurrence },
    wecomCalendar: {
      getStatus: vi.fn(async () => ({ ok: true as const, data: {
        source: 'WECOM_CALDAV' as const, connected: externalItems.length > 0, syncing: false,
        serverHost: 'caldav.wecom.work', accountHint: 'zh***',
        lastAttemptAtUtc: null, lastSuccessAtUtc: '2026-09-03T00:00:00.000Z', lastErrorCode: null,
        cachedEventCount: externalItems.length, cachedRangeStartOn: '2026-08-31', cachedRangeEndOn: '2026-10-04'
      } })),
      getRange: vi.fn(async ({ startOn, endOn }) => ({ ok: true as const, data: { startOn, endOn, items: externalItems } })),
      sync: vi.fn(), connect: vi.fn(), disconnect: vi.fn()
    }
  } as unknown as TodoDesktopApi
  return { applyProjectedOccurrence, createTask }
}

describe('CalendarPage', () => {
  it('日历全宽展示，选中日期后添加任务会预填该日期', async () => {
    const items: unknown[] = []
    const { createTask } = installApi(items)
    createTask.mockImplementation(async (input: { title: string; plannedOn: string }) => {
      const task = rawTask('drawer-created', input.title, input.plannedOn)
      items.push({ kind: 'TASK', task })
      return { ok: true, data: { value: task } }
    })
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    expect(await screen.findByRole('grid', { name: '月日历' })).toBeInTheDocument()
    expect(screen.queryByText('自然日视角')).not.toBeInTheDocument()
    expect(screen.queryByText('所选日期')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('gridcell', { name: /2026年9月4日.*0 项安排/ }))
    expect(screen.getByRole('dialog', { name: '2026年9月4日 周五' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog', { name: '2026年9月4日 周五' })).getByRole('button', { name: '添加任务' }))

    expect(await screen.findByRole('dialog', { name: '新建任务' })).toBeInTheDocument()
    expect(screen.getByLabelText(/计划完成时间/)).toHaveValue('2026-09-04')
    fireEvent.change(screen.getByLabelText(/任务标题/), { target: { value: '选中日期的新任务' } })
    fireEvent.click(screen.getByRole('button', { name: /^创建任务$/ }))
    expect(await screen.findByRole('button', { name: '查看任务“选中日期的新任务”' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: '2026年9月4日 周五' })).getByText('选中日期的新任务')).toBeInTheDocument()
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ plannedOn: '2026-09-04' }))
  })

  it('点击重复发生项只打开操作抽屉，不会生成任务或写入数据', async () => {
    const { applyProjectedOccurrence: apply } = installApi([{
      kind: 'PROJECTED_OCCURRENCE', occurrenceKey: 'series-1:2026-09-03', seriesId: 'series-1',
      expectedSeriesRowVersion: 2, appliedRuleVersionId: 'rule-1', originalOccurrenceOn: '2026-09-03',
      plannedOn: '2026-09-03', title: '每日复盘', notes: null, project: null, important: true, urgent: false
    }])
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    fireEvent.click(await screen.findByRole('button', { name: '查看重复任务“每日复盘”' }))

    expect(screen.getByRole('dialog', { name: '任务详情' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完成本次' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消本次' })).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
  })

  it('月视图优先清楚展示四项，“还有 N 项”在抽屉中展示当天完整列表', async () => {
    installApi(Array.from({ length: 5 }, (_, index) => ({ kind: 'TASK', task: rawTask(`task-${index}`, `任务 ${index + 1}`) })))
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    expect(await screen.findByRole('button', { name: '查看任务“任务 1”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看任务“任务 2”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看任务“任务 4”' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看任务“任务 5”' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '还有 1 项' }))

    expect(screen.getByRole('dialog', { name: '2026年9月3日 周四' })).toBeInTheDocument()
    expect(screen.getByText('2026-09-03 · 5 项')).toBeInTheDocument()
    expect(screen.getByText('任务 5')).toBeInTheDocument()
  })

  it('支持切换到充满主区域的周视图，并直接点击任务打开详情抽屉', async () => {
    installApi([{ kind: 'TASK', task: rawTask('task-1', '清楚展示的任务') }])
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    fireEvent.click(await screen.findByRole('button', { name: '周' }))
    expect(await screen.findByRole('grid', { name: '周日历' })).toHaveClass('calendar-grid--week')

    fireEvent.click(screen.getByRole('button', { name: '查看任务“清楚展示的任务”' }))
    expect(screen.getByRole('dialog', { name: '任务详情' })).toBeInTheDocument()
  })

  it('合并展示只读企业微信日程，保留时间、全天和地点且不生成任务', async () => {
    const timedEvent = {
      kind: 'EXTERNAL_EVENT', id: 'meeting-1', source: 'WECOM_CALDAV', title: '客户确认会',
      start: '2026-09-03T09:30:00', end: '2026-09-03T10:15:00', allDay: false,
      location: '一号会议室', timeZone: 'Asia/Shanghai'
    }
    const allDayEvent = {
      kind: 'EXTERNAL_EVENT', id: 'offsite-1', source: 'WECOM_CALDAV', title: '外出日',
      start: '2026-09-03', end: '2026-09-04', allDay: true, location: null, timeZone: null
    }
    const { createTask } = installApi(
      [{ kind: 'TASK', task: rawTask('task-merged', '当日任务') }],
      vi.fn(),
      [timedEvent, allDayEvent]
    )
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    expect(await screen.findByRole('button', { name: '查看任务“当日任务”' })).toBeInTheDocument()
    const timedChip = await screen.findByRole('button', { name: '查看企业微信日程“客户确认会”' })
    expect(timedChip).toHaveTextContent('09:30 客户确认会')
    expect(timedChip).not.toHaveTextContent('10:15')
    expect(timedChip).not.toHaveClass('calendar-chip--history')
    fireEvent.click(timedChip)
    expect(screen.getByRole('dialog', { name: '日程详情' })).toBeInTheDocument()
    expect(screen.getByText('企业微信 · 只读')).toBeInTheDocument()
    const eventHeading = screen.getByRole('heading', { name: '客户确认会' })
    expect(eventHeading).toBeInTheDocument()
    expect(eventHeading.nextElementSibling).toHaveTextContent('2026年9月3日 周四 · 09:30–10:15 · 一号会议室')
    expect(screen.queryByRole('button', { name: '编辑任务' })).not.toBeInTheDocument()
    expect(createTask).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '查看 2026年9月3日 周四 的全部任务' }))
    const allDayHeading = screen.getByRole('heading', { name: '外出日' })
    expect(allDayHeading).toBeInTheDocument()
    expect(allDayHeading.nextElementSibling).toHaveTextContent('2026年9月3日 周四 · 全天')
    expect(createTask).not.toHaveBeenCalled()
  })

  it('历史日期的企业微信日程使用独立的弱化颜色', async () => {
    installApi([], vi.fn(), [{
      kind: 'EXTERNAL_EVENT', id: 'past-1', source: 'WECOM_CALDAV', title: '历史会议',
      start: '2026-09-02T14:00:00', end: '2026-09-02T15:00:00', allDay: false,
      location: null, timeZone: 'Asia/Shanghai'
    }])
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    expect(await screen.findByRole('button', { name: '查看企业微信日程“历史会议”' }))
      .toHaveClass('calendar-chip--history')
  })

  it('多日企业微信日程会出现在覆盖到的每个日期中', async () => {
    installApi([], vi.fn(), [{
      kind: 'EXTERNAL_EVENT', id: 'trip-1', source: 'WECOM_CALDAV', title: '客户驻场',
      start: '2026-09-03', end: '2026-09-05', allDay: true,
      location: '上海', timeZone: null
    }])
    render(<CalendarPage today="2026-09-03" />, { wrapper })

    expect(await screen.findAllByRole('button', { name: '查看企业微信日程“客户驻场”' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('gridcell', { name: /2026年9月4日.*1 项安排/ }))
    expect(screen.getByRole('dialog', { name: '2026年9月4日 周五' })).toHaveTextContent('客户驻场')
    expect(screen.getByText('9月3日–9月4日 · 全天 · 上海')).toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: /2026年9月5日.*0 项安排/ })).toBeInTheDocument()
  })
})
