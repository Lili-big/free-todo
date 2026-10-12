import { useQuery, useQueryClient } from '@tanstack/react-query'
import { todoClient } from '../../client'
import { ErrorState, LoadingState, PageHeader } from '../components/States'
import { groupTasksByQuadrant, TaskQuadrants } from '../components/TaskQuadrants'
import { useTaskComposer } from '../components/TaskComposer'

type QuadrantSnapshot = Awaited<ReturnType<typeof todoClient.quadrants.snapshot>>

export function QuadrantsPage({ today }: { today: string }) {
  const snapshot = useQuery({ queryKey: ['quadrants'], queryFn: todoClient.quadrants.snapshot })
  const queryClient = useQueryClient()
  const composer = useTaskComposer()

  return (
    <div className="page page--wide">
      <PageHeader title="四象限" actions={<button className="button button--primary" type="button" onClick={() => composer.create()}>＋ 新建任务</button>} />
      {snapshot.isLoading ? <LoadingState /> : snapshot.isError || !snapshot.data ? <ErrorState error={snapshot.error} onRetry={() => snapshot.refetch()} /> : (
        <TaskQuadrants
          tasks={Object.values(snapshot.data).flat()}
          today={today}
          onTaskUpdated={(updated) => queryClient.setQueryData<QuadrantSnapshot>(['quadrants'], (current) => current
            ? groupTasksByQuadrant(Object.values(current).flat().map((task) => task.id === updated.id ? updated : task))
            : current)}
        />
      )}
    </div>
  )
}
