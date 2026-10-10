import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { todoClient } from '../../client'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'

export function PlanningPage({ today }: { today: string }) {
  const planning = useQuery({ queryKey: ['planning'], queryFn: todoClient.planning.snapshot })
  const projects = useQuery({ queryKey: ['projects'], queryFn: todoClient.projects.list })
  const [search, setSearch] = useState('')
  const [projectId, setProjectId] = useState('ALL')
  const composer = useTaskComposer()
  const filtered = useMemo(() => (planning.data ?? []).filter((task) => {
    const matchesSearch = !search.trim() || `${task.title} ${task.notes ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    const matchesProject = projectId === 'ALL' || (projectId === 'NONE' ? !task.project : task.project?.id === projectId)
    return matchesSearch && matchesProject
  }), [planning.data, projectId, search])

  return (
    <div className="page">
      <PageHeader title="待分配" actions={<button className="button button--primary" type="button" onClick={() => composer.create()}>＋ 添加任务</button>} />
      <div className="toolbar">
        <label className="search-box"><span>⌕</span><input aria-label="搜索待分配任务" placeholder="搜索标题或备注" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="toolbar-select"><span>项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="ALL">全部项目</option><option value="NONE">无项目</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <span className="toolbar__count">{filtered.length} 项待分配</span>
      </div>
      {planning.isLoading ? <LoadingState /> : planning.isError ? <ErrorState error={planning.error} onRetry={() => planning.refetch()} /> : filtered.length ? (
        <div className="task-stack task-stack--roomy">{filtered.map((task) => <TaskCard task={task} today={today} key={task.id} />)}</div>
      ) : <EmptyState icon="◇" title={planning.data?.length ? '没有匹配的事项' : '暂无待分配任务'} action={!planning.data?.length ? <button className="button button--secondary" type="button" onClick={() => composer.create()}>添加任务</button> : undefined} />}
    </div>
  )
}
