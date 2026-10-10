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
})
