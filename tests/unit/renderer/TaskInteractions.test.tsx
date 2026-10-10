// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { TodoDesktopApi } from '../../../src/shared/api'
import type { TaskItem } from '../../../src/renderer/domain'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { TaskCard } from '../../../src/renderer/src/components/TaskCard'
import { TaskComposerProvider, useTaskComposer } from '../../../src/renderer/src/components/TaskComposer'

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'child-1',
    title: '确认客户清单',
    notes: null,
    plannedOn: '2026-09-04',
    status: 'TODO',
    completedOn: null,
    cancelledOn: null,
    project: { id: 'project-a', name: '项目甲' },
    parent: null,
    important: false,
    urgent: false,
    hasChildren: false,
    isExecutable: true,
    pendingChildCount: 0,
    isOverdue: false,
    recurrenceSeriesId: null,
    originalOccurrenceOn: null,
    rowVersion: 1,
    ...overrides
  }
}

function toDto(task: TaskItem): Record<string, unknown> {
  return {
    id: task.id,
    version: task.rowVersion,
    title: task.title,
    notes: task.notes,
    status: task.status,
    plannedOn: task.plannedOn,
    completedOn: task.completedOn,
    cancelledOn: task.cancelledOn ?? null,
    important: task.important,
    urgent: task.urgent,
    project: task.project ? { ...task.project, status: 'ACTIVE' } : null,
    parent: task.parent ? { id: task.parent.id, title: task.parent.name, status: 'TODO' } : null,
    hasChildren: task.hasChildren,
    isExecutable: task.isExecutable,
    pendingChildCount: task.pendingChildCount,
    isOverdue: task.isOverdue,
    recurrence: null,
    children: (task.children ?? []).map(toDto),
    history: [],
    createdAtUtc: '2026-09-01T00:00:00.000Z',
    updatedAtUtc: '2026-09-01T00:00:00.000Z'
  }
}

function ok<T>(data: T) {
  return { ok: true as const, data }
}

function mutation(task: TaskItem) {
  return ok({ value: toDto(task), change: { dataEpoch: 'epoch', revision: 2, reason: 'test', tags: [] } })
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider><TaskComposerProvider today="2026-09-04">{children}</TaskComposerProvider></FeedbackProvider></QueryClientProvider>
}

function EditButton({ task }: { task: TaskItem }) {
  const composer = useTaskComposer()
  return <button type="button" onClick={() => composer.edit(task)}>打开任务</button>
}

function installEditorApi({
  task,
  parents,
  changeParent = vi.fn(async () => mutation(task)),
  createParentAndAttach = vi.fn(async () => mutation(task))
}: {
  task: TaskItem
  parents: TaskItem[]
  changeParent?: ReturnType<typeof vi.fn>
  createParentAndAttach?: ReturnType<typeof vi.fn>
}) {
  const getDetail = vi.fn(async () => ok(toDto(task)))
  const list = vi.fn(async () => ok({ items: parents.map(toDto), total: parents.length }))
  window.todoApi = {
    tasks: {
      getDetail,
      list,
      changeParent,
      createParentAndAttach,
      updateContent: vi.fn(async () => mutation(task)),
      setSchedule: vi.fn(async () => mutation(task))
    },
    projects: { list: vi.fn(async () => ok([])) }
  } as unknown as TodoDesktopApi
  return { getDetail, list, changeParent, createParentAndAttach }
}

describe('TaskComposer 父工作交互', () => {
  it('选择、更换父工作后随保存生效', async () => {
    const parentA = makeTask({ id: 'parent-a', title: '原父工作', project: { id: 'project-a', name: '项目甲' }, hasChildren: true, isExecutable: false })
    const parentB = makeTask({ id: 'parent-b', title: '新父工作', project: { id: 'project-a', name: '项目甲' }, hasChildren: true, isExecutable: false })
    const child = makeTask({ parent: { id: parentA.id, name: parentA.title } })
    const changeParent = vi.fn(async () => mutation({ ...child, parent: { id: parentB.id, name: parentB.title }, rowVersion: 2 }))
    installEditorApi({ task: child, parents: [parentA, parentB], changeParent })
    render(<EditButton task={child} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByRole('button', { name: '打开任务' }))
    const parentSelect = await screen.findByRole('combobox', { name: '父工作' })
    expect(parentSelect).toHaveDisplayValue('原父工作')
    await userEvent.selectOptions(parentSelect, parentB.id)
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(changeParent).toHaveBeenCalledWith({
      id: child.id,
      expectedVersion: child.rowVersion,
      parentId: parentB.id,
      confirmationToken: undefined
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument())
  })

  it('解除父工作后随保存生效', async () => {
    const parent = makeTask({ id: 'parent-a', title: '原父工作', hasChildren: true, isExecutable: false })
    const child = makeTask({ parent: { id: parent.id, name: parent.title } })
    const changeParent = vi.fn(async () => mutation({ ...child, parent: null, rowVersion: 2 }))
    installEditorApi({ task: child, parents: [parent], changeParent })
    render(<EditButton task={child} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByRole('button', { name: '打开任务' }))
    await screen.findByRole('combobox', { name: '父工作' })
    await userEvent.click(screen.getByRole('button', { name: '解除' }))
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(changeParent).toHaveBeenCalledWith({
      id: child.id,
      expectedVersion: child.rowVersion,
      parentId: null
    }))
  })

  it('“＋新建”原位输入，回车创建父工作并挂接', async () => {
    const child = makeTask()
    const createParentAndAttach = vi.fn(async () => mutation({ ...child, parent: { id: 'new-parent', name: '客户上线工作' }, rowVersion: 2 }))
    installEditorApi({ task: child, parents: [], createParentAndAttach })
    render(<EditButton task={child} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByRole('button', { name: '打开任务' }))
    await screen.findByRole('combobox', { name: '父工作' })
    await userEvent.click(screen.getByRole('button', { name: '＋ 新建' }))
    const newParentInput = screen.getByRole('textbox', { name: '新建父工作' })
    expect(newParentInput).toHaveFocus()
    await userEvent.type(newParentInput, '客户上线工作{Enter}')

    await waitFor(() => expect(createParentAndAttach).toHaveBeenCalledWith({
      childId: child.id,
      childExpectedVersion: child.rowVersion,
      title: '客户上线工作'
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument())
  })

  it('跨项目挂接需二次确认，确认后携带令牌完成挂接', async () => {
    const child = makeTask({ project: { id: 'project-a', name: '项目甲' } })
    const parent = makeTask({ id: 'parent-b', title: '项目乙父工作', project: { id: 'project-b', name: '项目乙' }, hasChildren: true, isExecutable: false })
    const changeParent = vi.fn(async (input: { confirmationToken?: string }) => input.confirmationToken
      ? mutation({ ...child, project: parent.project, parent: { id: parent.id, name: parent.title }, rowVersion: 2 })
      : ({ ok: false as const, error: {
          code: 'CONFIRMATION_REQUIRED' as const,
          message: '挂接后将迁移项目',
          retryable: false,
          traceId: 'trace',
          details: { confirmationToken: 'attach-token' }
        } }))
    installEditorApi({ task: child, parents: [parent], changeParent })
    render(<EditButton task={child} />, { wrapper: Wrapper })

    await userEvent.click(screen.getByRole('button', { name: '打开任务' }))
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: '父工作' }), parent.id)
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }))

    const dialog = await screen.findByRole('dialog', { name: '确认迁移并挂接？' })
    expect(dialog).toHaveTextContent('项目甲')
    expect(dialog).toHaveTextContent('项目乙')
    await userEvent.click(screen.getByRole('button', { name: '迁移并挂接' }))
    await waitFor(() => expect(changeParent).toHaveBeenLastCalledWith({
      id: child.id,
      expectedVersion: child.rowVersion,
      parentId: parent.id,
      confirmationToken: 'attach-token'
    }))
  })
})

describe('最后一个子工作完成后的父工作提示', () => {
  it('提供稍后决定、继续添加子工作、完成父工作三个出口且分别可执行', async () => {
    const parent = makeTask({
      id: 'parent-1',
      title: '上线客户门户',
      project: { id: 'project-a', name: '项目甲' },
      hasChildren: true,
      isExecutable: false,
      pendingChildCount: 0,
      rowVersion: 4
    })
    const child = makeTask({ parent: { id: parent.id, name: parent.title } })
    const doneChild = { ...child, status: 'DONE' as const, completedOn: '2026-09-04', rowVersion: 2 }
    const changeStatus = vi.fn(async (input: { id: string; status: string }) => input.id === parent.id
      ? mutation({ ...parent, status: 'DONE', completedOn: '2026-09-04', rowVersion: 5 })
      : mutation(doneChild))
    const getDetail = vi.fn(async () => ok(toDto(parent)))
    window.todoApi = {
      tasks: { changeStatus, getDetail },
      projects: { list: vi.fn(async () => ok([])) }
    } as unknown as TodoDesktopApi
    render(<TaskCard task={child} today="2026-09-04" />, { wrapper: Wrapper })

    const completeChild = screen.getByRole('button', { name: '标记完成' })
    await userEvent.click(completeChild)
    let dialog = await screen.findByRole('dialog', { name: '父工作还需要继续吗？' })
    expect(dialog).toHaveTextContent('已经没有其他待办子工作')
    expect(screen.getByRole('button', { name: '稍后决定' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续添加子工作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完成父工作' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '稍后决定' }))
    expect(dialog).not.toBeInTheDocument()

    await userEvent.click(completeChild)
    await userEvent.click(await screen.findByRole('button', { name: '继续添加子工作' }))
    expect(await screen.findByRole('dialog', { name: '添加子工作' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))

    await userEvent.click(completeChild)
    dialog = await screen.findByRole('dialog', { name: '父工作还需要继续吗？' })
    await userEvent.click(screen.getByRole('button', { name: '完成父工作' }))
    await waitFor(() => expect(changeStatus).toHaveBeenCalledWith({
      id: parent.id,
      expectedVersion: parent.rowVersion,
      status: 'DONE',
      confirmationToken: undefined
    }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })
})
