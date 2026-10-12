// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { TaskComposerProvider } from '../../../src/renderer/src/components/TaskComposer'
import { TodayPage } from '../../../src/renderer/src/pages/TodayPage'

const task = (id: string, title: string, plannedOn: string, isOverdue = false) => ({
  id, version: 1, title, notes: null, status: 'TODO' as const, plannedOn,
  completedOn: null, cancelledOn: null, important: false, urgent: false,
  project: null, parent: null, hasChildren: false, isExecutable: true,
  pendingChildCount: 0, isOverdue, recurrence: null,
  createdAtUtc: '2026-09-01T00:00:00.000Z', updatedAtUtc: '2026-09-01T00:00:00.000Z'
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider><TaskComposerProvider today="2026-09-02">{children}</TaskComposerProvider></FeedbackProvider></QueryClientProvider>
}

describe('TodayPage', () => {
  beforeEach(() => localStorage.clear())

  it('先展示今日，再展示遗留，并支持回车连续新增', async () => {
    const create = vi.fn(async () => ({ ok: true as const, data: { value: task('new', '新增', '2026-09-02'), change: { dataEpoch: 'e', revision: 2, reason: 'test', tags: ['TODAY' as const] } } }))
    const getSnapshot = vi.fn(async () => ({ ok: true as const, data: {
      localDate: '2026-09-02', reviewCardState: 'VISIBLE' as const,
      overdue: [task('old', '昨天未完成', '2026-09-01', true)],
      dueToday: [task('today', '今天交付方案', '2026-09-02')], completedToday: [],
      counts: { overdue: 1, dueToday: 1, completedToday: 0 }
    } }))
    window.todoApi = {
      today: { getSnapshot },
      tasks: { create },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi

    render(<TodayPage today="2026-09-02" />, { wrapper })

    expect(await screen.findByText('昨天未完成')).toBeInTheDocument()
    expect(screen.getByText('今天交付方案')).toBeInTheDocument()
    expect(screen.getByText('晨间复盘')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 新建今日任务' })).not.toBeInTheDocument()

    const todayHeading = screen.getByRole('heading', { name: /今日任务/ })
    const overdueHeading = screen.getByRole('heading', { name: /遗留待处理/ })
    expect(todayHeading.compareDocumentPosition(overdueHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const todayCard = screen.getByText('今天交付方案').closest('article')
    expect(todayCard).toHaveClass('task-card--today-row')
    expect(within(todayCard!).queryByLabelText('不重要不紧急')).not.toBeInTheDocument()

    const quickInput = screen.getByLabelText('快速添加今日任务')
    await userEvent.type(quickInput, '上午确认发布范围{Enter}')

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: '上午确认发布范围', plannedOn: '2026-09-02', important: false, urgent: false
    })))
    expect(quickInput).toHaveValue('')
    expect(quickInput).toHaveFocus()
    expect(screen.queryByRole('button', { name: '添加' })).not.toBeInTheDocument()
  })

  it('没有遗留时隐藏整个区块，手动添加带入已输入标题', async () => {
    const getSnapshot = vi.fn(async () => ({ ok: true as const, data: {
      localDate: '2026-09-02', reviewCardState: 'FINISHED' as const,
      overdue: [], dueToday: [], completedToday: [],
      counts: { overdue: 0, dueToday: 0, completedToday: 0 }
    } }))
    window.todoApi = {
      today: { getSnapshot },
      tasks: { list: vi.fn(async () => ({ ok: true, data: { items: [], total: 0 } })) },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi

    render(<TodayPage today="2026-09-02" />, { wrapper })

    const quickInput = await screen.findByLabelText('快速添加今日任务')
    expect(screen.queryByText('遗留待处理')).not.toBeInTheDocument()
    fireEvent.change(quickInput, { target: { value: '带入详细设置的标题' } })
    fireEvent.click(screen.getByRole('button', { name: '手动添加' }))

    expect(await screen.findByRole('textbox', { name: /任务标题/ })).toHaveValue('带入详细设置的标题')
  })

  it('复盘中一键将遗留任务移至今天，遗留与确认今日同步刷新', async () => {
    let moved = false
    const overdue = task('old', '昨天未完成', '2026-09-01', true)
    const updated = { ...overdue, version: 2, plannedOn: '2026-09-02', isOverdue: false }
    const setSchedule = vi.fn(async () => {
      moved = true
      return { ok: true as const, data: { value: updated } }
    })
    const snapshot = () => ({
      localDate: '2026-09-02', reviewCardState: 'VISIBLE' as const,
      overdue: moved ? [] : [overdue], dueToday: moved ? [updated] : [], completedToday: [],
      counts: { overdue: moved ? 0 : 1, dueToday: moved ? 1 : 0, completedToday: 0 }
    })
    window.todoApi = {
      today: {
        getSnapshot: vi.fn(async () => ({ ok: true, data: snapshot() })),
        getReviewSnapshot: vi.fn(async () => ({ ok: true, data: { ...snapshot(), yesterday: '2026-09-01', yesterdayOutcomes: [], unscheduled: [] } }))
      },
      tasks: { setSchedule },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<TodayPage today="2026-09-02" />, { wrapper })
    await userEvent.click(await screen.findByRole('button', { name: /开始复盘/ }))
    const dialog = screen.getByRole('dialog', { name: '晨间复盘' })
    await userEvent.click(await within(dialog).findByRole('button', { name: '移至今天' }))
    await waitFor(() => expect(setSchedule).toHaveBeenCalledWith({ id: 'old', expectedVersion: 1, plannedOn: '2026-09-02' }))
    expect(await within(dialog).findByText('没有遗留事项。')).toBeInTheDocument()
    expect(within(dialog).getByText('昨天未完成')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /遗留待处理/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '不重要不紧急象限' })).getByText('昨天未完成')).toBeInTheDocument()
    expect(setSchedule).toHaveBeenCalledOnce()
  })

  it('遗留任务改期失败时保留原遗留任务并显示原因', async () => {
    const overdue = task('old', '改期失败的任务', '2026-09-01', true)
    const snapshot = { localDate: '2026-09-02', reviewCardState: 'VISIBLE', overdue: [overdue], dueToday: [], completedToday: [] }
    const setSchedule = vi.fn(async () => ({ ok: false, error: { code: 'CONFLICT', message: '任务已被修改，请重试' } }))
    window.todoApi = {
      today: {
        getSnapshot: vi.fn(async () => ({ ok: true, data: snapshot })),
        getReviewSnapshot: vi.fn(async () => ({ ok: true, data: { ...snapshot, yesterday: '2026-09-01', yesterdayOutcomes: [], unscheduled: [] } }))
      },
      tasks: { setSchedule },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<TodayPage today="2026-09-02" />, { wrapper })
    await userEvent.click(await screen.findByRole('button', { name: /开始复盘/ }))
    const dialog = screen.getByRole('dialog', { name: '晨间复盘' })
    await userEvent.click(await within(dialog).findByRole('button', { name: '移至今天' }))
    expect(await screen.findByText('任务已被修改，请重试')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '移至今天' })).toBeEnabled()
    expect(within(dialog).getByText(/已逾期/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '不重要不紧急象限' })).not.toBeInTheDocument()
  })

  it('今日按 Q1 到 Q4 分组，仅收录今日任务，并记住列表切换', async () => {
    const todayTasks = [
      task('q4', '第四象限事项', '2026-09-02'),
      { ...task('q3', '第三象限事项', '2026-09-02'), urgent: true },
      { ...task('q1', '第一象限事项', '2026-09-02'), important: true, urgent: true },
      { ...task('q2', '第二象限事项', '2026-09-02'), important: true }
    ]
    window.todoApi = {
      today: { getSnapshot: vi.fn(async () => ({ ok: true, data: { localDate: '2026-09-02', reviewCardState: 'FINISHED', overdue: [task('old', '遗留事项', '2026-09-01', true)], dueToday: todayTasks, completedToday: [] } })) },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi
    const { unmount } = render(<TodayPage today="2026-09-02" />, { wrapper })
    await screen.findByText('第一象限事项')
    const regions = screen.getAllByRole('region', { name: /象限$/ })
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual(['重要且紧急象限', '重要不紧急象限', '不重要但紧急象限', '不重要不紧急象限'])
    for (const [index, region] of regions.entries()) {
      expect(within(region).getByText(['第一象限事项', '第二象限事项', '第三象限事项', '第四象限事项'][index]!)).toBeInTheDocument()
      expect(within(region).queryByText('遗留事项')).not.toBeInTheDocument()
    }
    await userEvent.click(screen.getByRole('button', { name: /^列表$/ }))
    expect(screen.queryByRole('region', { name: /象限$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^列表$/ })).toHaveAttribute('aria-pressed', 'true')
    unmount()
    render(<TodayPage today="2026-09-02" />, { wrapper })
    await screen.findByText('第一象限事项')
    expect(screen.getByRole('button', { name: /^列表$/ })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: '四象限分组' }))
    expect(screen.getAllByRole('region', { name: /象限$/ })).toHaveLength(4)
  })

  it('拖动今日任务到空象限，只更新象限属性，后续移动使用新版本', async () => {
    let current = { ...task('today', '调整今日象限', '2026-09-02'), notes: '保留备注' }
    const updateContent = vi.fn(async (input: { important: boolean; urgent: boolean }) => {
      current = { ...current, version: current.version + 1, important: input.important, urgent: input.urgent }
      return { ok: true, data: { value: current } }
    })
    window.todoApi = {
      today: { getSnapshot: vi.fn(async () => ({ ok: true, data: { localDate: '2026-09-02', reviewCardState: 'FINISHED', overdue: [], dueToday: [current], completedToday: [] } })) },
      tasks: { updateContent },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<TodayPage today="2026-09-02" />, { wrapper })
    await screen.findByText('调整今日象限')
    for (const [index, label] of ['重要且紧急象限', '重要不紧急象限'].entries()) {
      const title = screen.getByText('调整今日象限')
      const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() }
      fireEvent.mouseDown(title.closest('.task-card__main')!, { button: 0 })
      fireEvent.dragStart(title.closest('.quadrant-task')!, { dataTransfer })
      const destination = screen.getByRole('region', { name: label })
      fireEvent.dragEnter(destination, { dataTransfer })
      expect(within(destination).getByText('放到这里')).toBeInTheDocument()
      fireEvent.drop(destination, { dataTransfer })
      await waitFor(() => expect(updateContent).toHaveBeenNthCalledWith(index + 1, { id: 'today', expectedVersion: index + 1, important: true, urgent: index === 0 }))
      await waitFor(() => expect(within(destination).getByText('调整今日象限').closest('.quadrant-task')).toHaveAttribute('draggable', 'true'))
    }
    expect(current.plannedOn).toBe('2026-09-02')
    expect(current.notes).toBe('保留备注')
  })

  it('今日象限保存失败时回退到原分组并提示错误', async () => {
    const current = task('today', '不能保存的象限任务', '2026-09-02')
    window.todoApi = {
      today: { getSnapshot: vi.fn(async () => ({ ok: true, data: { localDate: '2026-09-02', reviewCardState: 'FINISHED', overdue: [], dueToday: [current], completedToday: [] } })) },
      tasks: { updateContent: vi.fn(async () => ({ ok: false, error: { code: 'CONFLICT', message: '象限保存失败' } })) },
      projects: { list: vi.fn(async () => ({ ok: true, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<TodayPage today="2026-09-02" />, { wrapper })
    const title = await screen.findByText('不能保存的象限任务')
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() }
    fireEvent.mouseDown(title.closest('.task-card__main')!, { button: 0 })
    fireEvent.dragStart(title.closest('.quadrant-task')!, { dataTransfer })
    fireEvent.drop(screen.getByRole('region', { name: '重要且紧急象限' }), { dataTransfer })
    expect(await screen.findByText('象限保存失败')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '不重要不紧急象限' })).getByText('不能保存的象限任务')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '重要且紧急象限' })).queryByText('不能保存的象限任务')).not.toBeInTheDocument()
  })
})
