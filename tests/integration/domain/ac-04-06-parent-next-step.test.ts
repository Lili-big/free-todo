import { DomainError } from '../../../src/main/domain/errors'
import { createDomainTestContext, realCalendarTaskIds, taskIds, type DomainTestContext } from './test-context'

describe('AC-04 ~ AC-06 parent tasks and project continuation', () => {
  let context: DomainTestContext

  beforeEach(() => {
    context = createDomainTestContext()
  })

  afterEach(() => context.manager.close())

  it('AC-04 dynamically removes a parent from execution views and rejects a grandchild', () => {
    const { store } = context
    const parent = store.createTask({ title: '粗粒度事项' }).value
    const child = store.createChildTask({
      title: '今日行动',
      parentId: parent.id,
      parentExpectedVersion: parent.version,
      plannedOn: '2026-09-02'
    }).value

    const parentDetail = store.getTaskDetail(parent.id)
    expect(parentDetail.isExecutable).toBe(false)
    expect(parentDetail.children.map((item) => item.id)).toEqual([child.id])
    expect(store.getPlanningSnapshot()).toHaveLength(0)
    expect(taskIds(store.getTodaySnapshot().dueToday)).toEqual([child.id])
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q4)).toEqual([child.id])
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-02', '2026-09-02').days)).toEqual([child.id])
    expect(() =>
      store.createChildTask({ title: '孙任务', parentId: child.id, parentExpectedVersion: child.version })
    ).toThrowError(expect.objectContaining({ code: 'TASK_DEPTH_EXCEEDED' }))

    const datedParent = store.setTaskSchedule({ id: parent.id, expectedVersion: parent.version, plannedOn: '2026-09-03' }).value
    expect(store.getPlanningSnapshot()).toHaveLength(0)
    expect(realCalendarTaskIds(store.getCalendarRange('2026-09-03', '2026-09-03').days)).toEqual([])
    expect(store.getTaskDetail(datedParent.id).id).toBe(parent.id)
    expect(store.listTasks().items.map((item) => item.id)).toEqual(expect.arrayContaining([parent.id, child.id]))
  })

  it('attaches an existing task, confirms cross-project migration and preserves execution facts', () => {
    const { store } = context
    const sourceProject = store.createProject({ name: '来源项目' }).value
    const targetProject = store.createProject({ name: '父任务项目' }).value
    const parent = store.createTask({ title: '粗略事项', projectId: targetProject.id }).value
    const created = store.createTask({ title: '已有行动', projectId: sourceProject.id, important: true }).value
    const child = store.setTaskSchedule({ id: created.id, expectedVersion: created.version, plannedOn: '2026-09-03' }).value
    const historyBefore = store.getTaskDetail(child.id).history

    let token = ''
    expect(() => {
      try {
        store.changeTaskParent({ id: child.id, expectedVersion: child.version, parentId: parent.id })
      } catch (error) {
        token = String((error as DomainError).details?.confirmationToken)
        throw error
      }
    }).toThrowError(expect.objectContaining({
      code: 'CONFIRMATION_REQUIRED',
      details: expect.objectContaining({ kind: 'ATTACH_TASK_TO_PARENT_AND_MOVE_PROJECT' })
    }))

    const attached = store.changeTaskParent({
      id: child.id,
      expectedVersion: child.version,
      parentId: parent.id,
      confirmationToken: token
    }).value
    expect(attached.parent?.id).toBe(parent.id)
    expect(attached.project?.id).toBe(targetProject.id)
    expect(attached).toMatchObject({
      plannedOn: '2026-09-03',
      status: 'TODO',
      important: true,
      urgent: false
    })
    expect(attached.history).toEqual(historyBefore)
    expect(taskIds(store.getQuadrantSnapshot().quadrants.Q2)).toContain(child.id)
    expect(store.getProjectDetail(sourceProject.id).tasks.map((task) => task.id)).not.toContain(child.id)
    expect(store.getProjectDetail(targetProject.id).tasks.map((task) => task.id)).toEqual(expect.arrayContaining([parent.id, child.id]))
  })

  it('creates a rough parent and attaches an existing leaf task in one operation', () => {
    const { store } = context
    const project = store.createProject({ name: '客户确认' }).value
    const child = store.createTask({ title: '继续确认范围', projectId: project.id }).value

    const attached = store.createParentAndAttach({
      childId: child.id,
      childExpectedVersion: child.version,
      title: '完成需求确认'
    }).value

    expect(attached.parent?.title).toBe('完成需求确认')
    expect(attached.project?.id).toBe(project.id)
    expect(attached.plannedOn).toBeNull()
    expect(taskIds(store.getPlanningSnapshot())).toEqual([child.id])
    const parent = store.getTaskDetail(attached.parent!.id)
    expect(parent.isExecutable).toBe(false)
    expect(parent.children.map((task) => task.id)).toEqual([child.id])
  })

  it('AC-05 keeps parent status manual and uses a fact-bound confirmation without cascading', () => {
    const { store } = context
    const parent = store.createTask({ title: '父任务' }).value
    const first = store.createChildTask({ title: '子项1', parentId: parent.id, parentExpectedVersion: parent.version }).value
    const second = store.createChildTask({ title: '子项2', parentId: parent.id, parentExpectedVersion: parent.version }).value
    store.changeTaskStatus({ id: first.id, expectedVersion: first.version, status: 'DONE' })
    expect(store.getTaskDetail(parent.id).status).toBe('TODO')
    expect(store.getTaskDetail(parent.id).pendingChildCount).toBe(1)

    let token = ''
    try {
      store.changeTaskStatus({ id: parent.id, expectedVersion: parent.version, status: 'CANCELLED' })
      throw new Error('expected confirmation')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      const domain = error as DomainError
      expect(domain.code).toBe('CONFIRMATION_REQUIRED')
      expect(domain.details?.facts).toEqual({ pendingChildCount: 1 })
      token = String(domain.details?.confirmationToken)
    }
    const cancelledParent = store.changeTaskStatus({
      id: parent.id,
      expectedVersion: parent.version,
      status: 'CANCELLED',
      confirmationToken: token
    }).value
    expect(cancelledParent.status).toBe('CANCELLED')
    expect(store.getTaskDetail(first.id).status).toBe('DONE')
    expect(store.getTaskDetail(second.id).status).toBe('TODO')

    const restored = store.changeTaskStatus({ id: parent.id, expectedVersion: cancelledParent.version, status: 'TODO' }).value
    const finishedSecond = store.changeTaskStatus({ id: second.id, expectedVersion: second.version, status: 'CANCELLED' }).value
    expect(finishedSecond.status).toBe('CANCELLED')
    expect(store.getTaskDetail(restored.id).status).toBe('TODO')
    expect(store.getTaskDetail(restored.id).pendingChildCount).toBe(0)
  })

  it('AC-06 creates independent next steps with conditional parent inheritance and keeps prior history', () => {
    const { store } = context
    const project = store.createProject({ name: '客户功能确认' }).value
    const parent = store.createTask({ title: '完成整体确认', projectId: project.id }).value
    const today = store.createChildTask({
      title: '给出功能清单',
      parentId: parent.id,
      parentExpectedVersion: parent.version,
      plannedOn: '2026-09-02'
    }).value
    const completedToday = store.changeTaskStatus({ id: today.id, expectedVersion: today.version, status: 'DONE' }).value
    const tomorrow = store.createNextStep({
      sourceTaskId: completedToday.id,
      title: '继续与客户确认',
      plannedOn: '2026-09-03'
    }).value
    expect(tomorrow.id).not.toBe(today.id)
    expect(tomorrow.project?.id).toBe(project.id)
    expect(tomorrow.parent?.id).toBe(parent.id)
    expect(store.getTaskDetail(today.id).status).toBe('DONE')
    expect(store.getTaskDetail(today.id).history.some((event) => event.kind === 'STATUS')).toBe(true)

    const finishedTomorrow = store.changeTaskStatus({ id: tomorrow.id, expectedVersion: tomorrow.version, status: 'DONE' }).value
    expect(finishedTomorrow.status).toBe('DONE')
    const completedParent = store.changeTaskStatus({ id: parent.id, expectedVersion: parent.version, status: 'DONE' }).value
    expect(completedParent.status).toBe('DONE')
    expect(store.getProjectDetail(project.id).status).toBe('ACTIVE')
    expect(store.getProjectDetail(project.id).hasNextAction).toBe(false)

    const rootNext = store.createNextStep({
      sourceTaskId: completedToday.id,
      title: '父任务结束后的新一步',
      plannedOn: '2026-09-04'
    }).value
    expect(rootNext.project?.id).toBe(project.id)
    expect(rootNext.parent).toBeNull()
    expect(store.listTasks().total).toBe(4)
  })
})
