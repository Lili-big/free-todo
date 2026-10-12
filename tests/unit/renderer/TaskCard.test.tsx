// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { TaskCardView } from '../../../src/renderer/src/components/TaskCard'
import type { TaskItem } from '../../../src/renderer/domain'

const baseTask: TaskItem = {
  id: 'task-1',
  title: '确认客户功能清单',
  notes: null,
  plannedOn: '2026-09-01',
  status: 'TODO',
  completedOn: null,
  project: { id: 'project-1', name: '客户门户改版' },
  parent: { id: 'parent-1', name: '完成需求确认' },
  important: true,
  urgent: false,
  hasChildren: false,
  isExecutable: true,
  pendingChildCount: 0,
  isOverdue: true,
  recurrenceSeriesId: null,
  originalOccurrenceOn: null,
  rowVersion: 1
}

describe('TaskCardView', () => {
  it('展示同一任务的日期、项目、父任务和象限上下文', () => {
    render(<TaskCardView task={baseTask} today="2026-09-02" onToggleDone={vi.fn()} onOpen={vi.fn()} />)

    expect(screen.getByText('确认客户功能清单')).toBeInTheDocument()
    expect(screen.getByText('客户门户改版 · ↳ 完成需求确认')).toBeInTheDocument()
    expect(screen.getByText(/已逾期/)).toBeInTheDocument()
    expect(screen.getByLabelText('重要不紧急')).toBeInTheDocument()
  })

  it('父任务明确展示待办子项数量且不伪装为普通执行项', () => {
    render(<TaskCardView task={{ ...baseTask, hasChildren: true, isExecutable: false, pendingChildCount: 3 }} today="2026-09-02" />)

    expect(screen.getByText('父工作 · 3 项待办')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '父工作状态' })).toHaveTextContent('−')
  })

  it('今日单行只展示已选的象限标识，不重复展示日期', () => {
    const { rerender } = render(<TaskCardView task={baseTask} today="2026-09-02" todayRow onOpen={vi.fn()} />)

    const row = screen.getByText('确认客户功能清单').closest('article')
    expect(row).toHaveClass('task-card--today-row', 'has-quadrant')
    expect(within(row!).getByLabelText('重要不紧急')).toHaveTextContent('重')
    expect(within(row!).getByLabelText('重要不紧急')).not.toHaveTextContent('急')
    expect(within(row!).queryByText(/已逾期/)).not.toBeInTheDocument()

    rerender(<TaskCardView task={{ ...baseTask, important: false, urgent: true }} today="2026-09-02" todayRow onOpen={vi.fn()} />)
    expect(screen.getByLabelText('不重要但紧急')).toHaveTextContent('急')
    expect(screen.getByLabelText('不重要但紧急')).not.toHaveTextContent('重')

    rerender(<TaskCardView task={{ ...baseTask, important: true, urgent: true }} today="2026-09-02" todayRow onOpen={vi.fn()} />)
    expect(screen.getByLabelText('重要且紧急')).toHaveTextContent('重急')

    rerender(<TaskCardView task={{ ...baseTask, important: false, urgent: false }} today="2026-09-02" todayRow onOpen={vi.fn()} />)
    expect(screen.queryByLabelText('不重要不紧急')).not.toBeInTheDocument()
    expect(screen.getByText('确认客户功能清单').closest('article')).not.toHaveClass('has-quadrant')
  })

  it('单击任务主内容打开详情，旁侧操作不会误开详情', async () => {
    const onOpen = vi.fn()
    const onToggleDone = vi.fn()
    const onCancel = vi.fn()
    const onSchedule = vi.fn()
    render(<TaskCardView
      task={baseTask}
      today="2026-09-02"
      onOpen={onOpen}
      onToggleDone={onToggleDone}
      onCancel={onCancel}
      onSchedule={onSchedule}
    />)

    await userEvent.click(screen.getByRole('button', { name: '标记完成' }))
    await userEvent.click(screen.getByRole('button', { name: '待分配' }))
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onToggleDone).toHaveBeenCalledOnce()
    expect(onSchedule).toHaveBeenCalledWith(null)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /确认客户功能清单/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('日期弹层同时编辑开始与完成时间，确认后一起保存，并可由外部点击或 Esc 关闭', async () => {
    const onSchedule = vi.fn()
    render(<TaskCardView task={baseTask} today="2026-09-02" onSchedule={onSchedule} />)

    await userEvent.click(screen.getByRole('button', { name: '日期' }))
    let dateInput = screen.getByLabelText('选择计划完成时间')
    expect(screen.queryByRole('button', { name: '清除' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()

    // The native picker may move focus internally; blur alone must not tear it down.
    fireEvent.blur(dateInput)
    expect(screen.getByLabelText('选择计划完成时间')).toBeInTheDocument()
    fireEvent.change(dateInput, { target: { value: '2026-09-08' } })
    fireEvent.change(screen.getByLabelText('选择计划开始时间'), { target: { value: '2026-09-03' } })
    expect(onSchedule).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '保存时间' }))
    expect(onSchedule).toHaveBeenCalledWith('2026-09-08', '2026-09-03')
    expect(screen.queryByLabelText('选择计划完成时间')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '日期' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByLabelText('选择计划完成时间')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '日期' }))
    dateInput = screen.getByLabelText('选择计划完成时间')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dateInput).not.toBeInTheDocument()
  })

  it('父工作不提供“待分配”操作', () => {
    render(<TaskCardView
      task={{ ...baseTask, hasChildren: true, isExecutable: false, pendingChildCount: 1 }}
      today="2026-09-02"
      onSchedule={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: '日期' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '待分配' })).not.toBeInTheDocument()
  })
})
