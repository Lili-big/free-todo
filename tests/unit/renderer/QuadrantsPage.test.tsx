// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { TaskComposerProvider } from '../../../src/renderer/src/components/TaskComposer'
import { QuadrantsPage } from '../../../src/renderer/src/pages/QuadrantsPage'

const task = {
  id: 'task-1', version: 1, title: '整理资料', notes: null, status: 'TODO' as const, plannedOn: null,
  completedOn: null, cancelledOn: null, important: false, urgent: false,
  project: null, parent: null, hasChildren: false, isExecutable: true,
  pendingChildCount: 0, isOverdue: false, recurrence: null,
  createdAtUtc: '2026-09-01T00:00:00.000Z', updatedAtUtc: '2026-09-01T00:00:00.000Z'
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider><TaskComposerProvider today="2026-09-03">{children}</TaskComposerProvider></FeedbackProvider></QueryClientProvider>
}

function transfer() {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn(), getData: vi.fn(() => '') }
}

describe('QuadrantsPage', () => {
  it('从任务卡主体拖到空象限并立即更新重要、紧急属性', async () => {
    let moved = false
    const updateContent = vi.fn(async () => {
      moved = true
      return { ok: true as const, data: { value: { ...task, version: 2, important: true, urgent: true }, change: { dataEpoch: 'e', revision: 2, reason: 'test', tags: [] } } }
    })
    window.todoApi = {
      quadrants: { getSnapshot: vi.fn(async () => ({ ok: true as const, data: { localDate: '2026-09-03', quadrants: { Q1: moved ? [{ ...task, version: 2, important: true, urgent: true }] : [], Q2: [], Q3: [], Q4: moved ? [] : [task] } } })) },
      tasks: { updateContent },
      projects: { list: vi.fn(async () => ({ ok: true as const, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<QuadrantsPage today="2026-09-03" />, { wrapper })

    const title = await screen.findByText('整理资料')
    const card = title.closest('.quadrant-task') as HTMLElement
    const cardMain = title.closest('.task-card__main') as HTMLElement
    const destination = screen.getByRole('region', { name: '重要且紧急象限' })
    const dataTransfer = transfer()
    expect(card).toHaveAttribute('draggable', 'true')
    expect(screen.queryByRole('button', { name: '拖动“整理资料”调整象限' })).not.toBeInTheDocument()
    fireEvent.mouseDown(cardMain, { button: 0 })
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.dragEnter(destination, { dataTransfer })
    expect(within(destination).getByText('放到这里')).toBeInTheDocument()
    fireEvent.dragOver(destination, { dataTransfer })
    fireEvent.drop(destination, { dataTransfer })

    await waitFor(() => expect(updateContent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-1', expectedVersion: 1, important: true, urgent: true
    })))
    await waitFor(() => expect(within(destination).getByText('整理资料')).toBeInTheDocument())
    expect(screen.queryByLabelText(/调整“整理资料”的象限/)).not.toBeInTheDocument()
  })

  it('移动失败时回到原象限并显示错误', async () => {
    window.todoApi = {
      quadrants: { getSnapshot: vi.fn(async () => ({ ok: true as const, data: { localDate: '2026-09-03', quadrants: { Q1: [], Q2: [], Q3: [], Q4: [task] } } })) },
      tasks: { updateContent: vi.fn(async () => ({ ok: false as const, error: { code: 'CONFLICT', message: '任务已被修改' } })) },
      projects: { list: vi.fn(async () => ({ ok: true as const, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<QuadrantsPage today="2026-09-03" />, { wrapper })

    const title = await screen.findByText('整理资料')
    const card = title.closest('.quadrant-task') as HTMLElement
    const cardMain = title.closest('.task-card__main') as HTMLElement
    const destination = screen.getByRole('region', { name: '重要且紧急象限' })
    const source = screen.getByRole('region', { name: '不重要不紧急象限' })
    const dataTransfer = transfer()
    fireEvent.mouseDown(cardMain, { button: 0 })
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(destination, { dataTransfer })

    expect(await screen.findByText('任务已被修改')).toBeInTheDocument()
    expect(within(source).getByText('整理资料')).toBeInTheDocument()
    expect(within(destination).queryByText('整理资料')).not.toBeInTheDocument()
  })

  it('从勾选按钮开始移动时不触发象限拖拽', async () => {
    const updateContent = vi.fn()
    window.todoApi = {
      quadrants: { getSnapshot: vi.fn(async () => ({ ok: true as const, data: { localDate: '2026-09-03', quadrants: { Q1: [], Q2: [], Q3: [], Q4: [task] } } })) },
      tasks: { updateContent },
      projects: { list: vi.fn(async () => ({ ok: true as const, data: [] })) }
    } as unknown as TodoDesktopApi
    render(<QuadrantsPage today="2026-09-03" />, { wrapper })

    const title = await screen.findByText('整理资料')
    const card = title.closest('.quadrant-task') as HTMLElement
    const check = screen.getByRole('button', { name: '标记完成' })
    const destination = screen.getByRole('region', { name: '重要且紧急象限' })
    const dataTransfer = transfer()
    fireEvent.mouseDown(check, { button: 0 })
    expect(fireEvent.dragStart(card, { dataTransfer })).toBe(false)
    fireEvent.dragEnter(destination, { dataTransfer })
    fireEvent.drop(destination, { dataTransfer })

    expect(updateContent).not.toHaveBeenCalled()
    expect(within(destination).queryByText('放到这里')).not.toBeInTheDocument()
  })
})
