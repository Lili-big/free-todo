import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TaskItem, TaskStatus } from '../../domain'
import { todoClient } from '../../client'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'

const ALL = 'ALL'

export function TasksPage({ today }: { today: string }) {
  const [status, setStatus] = useState<TaskStatus | typeof ALL>(ALL)
  const [search, setSearch] = useState('')
  const [projectId, setProjectId] = useState(ALL)
  const [parentId, setParentId] = useState(ALL)
  const [showCompleted, setShowCompleted] = useState(false)
  const [collapsedParentIds, setCollapsedParentIds] = useState<Set<string>>(() => new Set())
  const tasks = useQuery({
    queryKey: ['tasks', status, search],
    queryFn: () => todoClient.tasks.list({ status, search, pageSize: 1000 })
  })
  const hierarchy = useQuery({
    queryKey: ['tasks', 'overview-hierarchy'],
    queryFn: () => todoClient.tasks.list({ pageSize: 1000 })
  })
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list })
  const composer = useTaskComposer()

  const matchesProject = (task: TaskItem) => projectId === ALL || (projectId === 'NONE' ? !task.project : task.project?.id === projectId)
  const completedVisible = showCompleted || status === 'DONE'
  const cancelledVisible = showCompleted || status === 'CANCELLED'
  const filtered = useMemo(
    () => (tasks.data ?? []).filter((task) => matchesProject(task) && (completedVisible || task.status !== 'DONE') && (cancelledVisible || task.status !== 'CANCELLED')),
    [completedVisible, cancelledVisible, projectId, tasks.data]
  )
  const hierarchyTasks = useMemo(
    () => (hierarchy.data ?? []).filter((task) => matchesProject(task) && (completedVisible || task.status !== 'DONE') && (cancelledVisible || task.status !== 'CANCELLED')),
    [completedVisible, cancelledVisible, hierarchy.data, projectId]
  )
  const hierarchyChildrenByParent = useMemo(() => {
    const children = new Map<string, TaskItem[]>()
    hierarchyTasks.forEach((task) => {
      if (!task.parent) return
      const siblings = children.get(task.parent.id) ?? []
      siblings.push(task)
      children.set(task.parent.id, siblings)
    })
    return children
  }, [hierarchyTasks])
  const parentOptions = useMemo(
    () => hierarchyTasks.filter((task) => !task.parent && (task.hasChildren || hierarchyChildrenByParent.has(task.id))),
    [hierarchyChildrenByParent, hierarchyTasks]
  )
  const selectedParent = parentId === ALL ? null : parentOptions.find((task) => task.id === parentId) ?? null
  const visibleGroups = useMemo(() => {
    if (selectedParent) {
      return [{ parent: selectedParent, children: filtered.filter((task) => task.parent?.id === selectedParent.id), selected: true }]
    }

    const filteredIds = new Set(filtered.map((task) => task.id))
    return parentOptions.flatMap((parent) => {
      const children = filtered.filter((task) => task.parent?.id === parent.id)
      return filteredIds.has(parent.id) || children.length > 0
        ? [{ parent, children, selected: false }]
        : []
    })
  }, [filtered, parentOptions, selectedParent])
  const groupedIds = useMemo(() => {
    const ids = new Set<string>()
    visibleGroups.forEach(({ parent, children }) => {
      ids.add(parent.id)
      children.forEach((child) => ids.add(child.id))
    })
    return ids
  }, [visibleGroups])
  const independentTasks = parentId === ALL ? filtered.filter((task) => !groupedIds.has(task.id)) : []
  const visibleParentIds = visibleGroups.map(({ parent }) => parent.id)
  const hasVisibleGroups = visibleParentIds.length > 0
  const everyVisibleGroupCollapsed = hasVisibleGroups && visibleParentIds.every((id) => collapsedParentIds.has(id))
  const everyVisibleGroupExpanded = visibleParentIds.every((id) => !collapsedParentIds.has(id))
  const hasResults = visibleGroups.length > 0 || independentTasks.length > 0
  const resultCount = selectedParent ? visibleGroups[0]?.children.length ?? 0 : filtered.length

  const setGroupCollapsed = (id: string, collapsed: boolean) => {
    setCollapsedParentIds((current) => {
      const next = new Set(current)
      if (collapsed) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const collapseAll = () => {
    setCollapsedParentIds((current) => new Set([...current, ...visibleParentIds]))
  }

  const expandAll = () => {
    setCollapsedParentIds((current) => {
      const next = new Set(current)
      visibleParentIds.forEach((id) => next.delete(id))
      return next
    })
  }

  return (
    <div className="page">
      <PageHeader title="任务总览" actions={<button className="button button--primary" type="button" onClick={() => composer.create()}>＋ 新建任务</button>} />
      <div className="toolbar toolbar--wrap">
        <label className="search-box"><span>⌕</span><input aria-label="搜索全部任务" placeholder="搜索任务" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="segmented" aria-label="任务状态筛选">{([[ALL, '全部'], ['TODO', '待办'], ['DONE', '已完成'], ['CANCELLED', '已取消']] as const).map(([value, label]) => <button key={value} type="button" className={status === value ? 'is-active' : ''} onClick={() => setStatus(value)}>{label}</button>)}</div>
        <label className="toolbar-select"><select aria-label="按项目筛选" value={projectId} onChange={(event) => { setProjectId(event.target.value); setParentId(ALL) }}><option value={ALL}>全部项目</option><option value="NONE">无项目</option>{(projects.data ?? []).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label className="toolbar-select"><select aria-label="按父工作筛选" value={parentId} onChange={(event) => setParentId(event.target.value)}><option value={ALL}>全部父工作</option>{parentOptions.map((parent) => <option value={parent.id} key={parent.id}>{parent.title}</option>)}</select></label>
        <label className="toolbar-check"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />显示已完成和已取消</label>
        {hasVisibleGroups && <div className="segmented task-tree-controls" aria-label="父工作展开状态"><button type="button" onClick={collapseAll} disabled={everyVisibleGroupCollapsed}>全部折叠</button><button type="button" onClick={expandAll} disabled={everyVisibleGroupExpanded}>全部展开</button></div>}
        <span className="toolbar__count">{selectedParent ? `${resultCount} 条子工作` : `${resultCount} 条记录`}</span>
      </div>
      {tasks.isLoading || hierarchy.isLoading ? <LoadingState /> : tasks.isError || hierarchy.isError ? <ErrorState error={tasks.error ?? hierarchy.error} onRetry={() => { void tasks.refetch(); void hierarchy.refetch() }} /> : hasResults ? (
        <div className="task-tree-list">
          {visibleGroups.map(({ parent, children, selected }) => {
            const collapsed = collapsedParentIds.has(parent.id)
            return <section className={`task-tree-node has-children${collapsed ? ' is-collapsed' : ''}`} key={parent.id}>
              <div className="task-tree-node__parent">
                <button
                  type="button"
                  className="task-tree-node__toggle"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? '展开' : '折叠'}父工作“${parent.title}”`}
                  title={collapsed ? '展开子工作' : '折叠子工作'}
                  onClick={() => setGroupCollapsed(parent.id, !collapsed)}
                >{collapsed ? '›' : '⌄'}</button>
                <TaskCard task={{ ...parent, children: hierarchyChildrenByParent.get(parent.id) ?? children }} today={today} />
              </div>
              {!collapsed && <div className="task-tree-node__children">
                {children.map((child) => <TaskCard task={child} today={today} compact key={child.id} />)}
                {selected && children.length === 0 && <span className="task-tree-node__empty">没有符合筛选的子工作</span>}
                {parent.status === 'TODO' && <button type="button" className="add-child-row" onClick={() => composer.child(parent)}>＋ 添加下一条子工作</button>}
              </div>}
            </section>
          })}
          {independentTasks.map((task) => <section className="task-tree-node" key={task.id}><TaskCard task={task} today={today} /></section>)}
        </div>
      ) : <EmptyState icon="☷" title={search || projectId !== ALL || status !== ALL || parentId !== ALL ? '没有符合筛选的任务' : '还没有任务'} />}
    </div>
  )
}
