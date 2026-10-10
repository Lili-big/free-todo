// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { TaskComposerProvider } from '../../../src/renderer/src/components/TaskComposer'
import { TasksPage } from '../../../src/renderer/src/pages/TasksPage'

const task = (
  id: string,
  title: string,
  options: {
    status?: 'TODO' | 'DONE' | 'CANCELLED'
    parent?: { id: string; name: string } | null
    hasChildren?: boolean
  } = {}
) => ({
  id,
  rowVersion: 1,
  title,
  notes: null,
  status: options.status ?? 'TODO',
  plannedOn: null,
  completedOn: options.status === 'DONE' ? '2026-09-02' : null,
  cancelledOn: options.status === 'CANCELLED' ? '2026-09-02' : null,
  important: false,
  urgent: false,
  project: null,
  parent: options.parent ?? null,
  hasChildren: options.hasChildren ?? false,
  isExecutable: !(options.hasChildren ?? false),
  pendingChildCount: options.hasChildren ? 1 : 0,
  isOverdue: false,
  recurrenceSeriesId: null,
  originalOccurrenceOn: null
})

const parentA = task('parent-a', '发布新版', { hasChildren: true })
const parentB = task('parent-b', '整理知识库', { hasChildren: true })
const childATodo = task('child-a-todo', '完成发布检查', { parent: { id: parentA.id, name: parentA.title } })
const childADone = task('child-a-done', '确认发布范围', { status: 'DONE', parent: { id: parentA.id, name: parentA.title } })
const childB = task('child-b', '迁移旧文档', { parent: { id: parentB.id, name: parentB.title } })
const independent = task('independent', '购买打印纸')
const completedParent = task('parent-done', '已完成父工作', { status: 'DONE', hasChildren: true })
const cancelled = task('cancelled', '已取消的旧工作', { status: 'CANCELLED' })
const allTasks = [parentA, childATodo, childADone, parentB, childB, independent, completedParent, cancelled]

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider><TaskComposerProvider today="2026-09-03">{children}</TaskComposerProvider></FeedbackProvider></QueryClientProvider>
}

function installApi() {
  const list = vi.fn(async (input: { status?: string; search?: string } = {}) => {
    let items = allTasks
    if (input.status && input.status !== 'ALL') items = items.filter((item) => item.status === input.status)
    if (input.search?.trim()) {
      const term = input.search.trim().toLocaleLowerCase()
      items = items.filter((item) => item.title.toLocaleLowerCase().includes(term))
    }
    return { ok: true as const, data: { items, total: items.length } }
  })
  window.todoApi = {
    tasks: { list },
    projects: { list: vi.fn(async () => ({ ok: true as const, data: [] })) }
  } as unknown as TodoDesktopApi
  return list
}

describe('TasksPage', () => {
  it('默认隐藏已完成和已取消，但可通过开关或对应状态查看', async () => {
    installApi()
    render(<TasksPage today="2026-09-03" />, { wrapper })
    await screen.findByText('购买打印纸')
    expect(screen.queryByText('已取消的旧工作')).not.toBeInTheDocument()
    expect(screen.queryByText('确认发布范围')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成和已取消' }))
    expect(screen.getByText('已取消的旧工作')).toBeInTheDocument()
    expect(screen.getByText('确认发布范围')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成和已取消' }))
    fireEvent.click(screen.getByRole('button', { name: '已取消' }))
    expect(await screen.findByText('已取消的旧工作')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '已完成' }))
    expect(await screen.findByText('确认发布范围')).toBeInTheDocument()
  })
  it('可聚焦一个父工作，状态和搜索只筛选子工作并保留父工作上下文', async () => {
    installApi()
    render(<TasksPage today="2026-09-03" />, { wrapper })

    const parentFilter = await screen.findByRole('combobox', { name: '按父工作筛选' })
    expect(parentFilter).toHaveDisplayValue('全部父工作')
    await screen.findByRole('option', { name: '发布新版' })
    await userEvent.selectOptions(parentFilter, parentA.id)

    await waitFor(() => expect(screen.queryByText('整理知识库', { selector: 'strong' })).not.toBeInTheDocument())
    expect(screen.getByText('发布新版', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('完成发布检查')).toBeInTheDocument()
    expect(screen.queryByText('确认发布范围')).not.toBeInTheDocument()
    expect(screen.queryByText('已完成父工作')).not.toBeInTheDocument()
    expect(screen.queryByText('购买打印纸')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成和已取消' }))
    expect(screen.getByText('确认发布范围')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已完成' }))
    expect(await screen.findByText('确认发布范围')).toBeInTheDocument()
    expect(screen.queryByText('完成发布检查')).not.toBeInTheDocument()
    expect(screen.getByText('发布新版', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('1 条子工作')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: '搜索全部任务' }), { target: { value: '不存在的任务' } })
    expect(await screen.findByText('没有符合筛选的子工作')).toBeInTheDocument()
    expect(screen.getByText('发布新版', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('0 条子工作')).toBeInTheDocument()
  })

  it('父工作默认展开，并支持单独折叠、全部折叠和全部展开', async () => {
    installApi()
    render(<TasksPage today="2026-09-03" />, { wrapper })

    const collapseA = await screen.findByRole('button', { name: '折叠父工作“发布新版”' })
    expect(collapseA).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('完成发布检查')).toBeInTheDocument()
    expect(screen.getByText('迁移旧文档')).toBeInTheDocument()

    fireEvent.click(collapseA)
    expect(screen.queryByText('完成发布检查')).not.toBeInTheDocument()
    expect(screen.getByText('迁移旧文档')).toBeInTheDocument()
    expect(screen.getByText('购买打印纸')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '全部折叠' }))
    expect(screen.queryByText('迁移旧文档')).not.toBeInTheDocument()
    expect(screen.getByText('购买打印纸')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
    expect(screen.getByText('完成发布检查')).toBeInTheDocument()
    expect(screen.getByText('迁移旧文档')).toBeInTheDocument()
  })
})
