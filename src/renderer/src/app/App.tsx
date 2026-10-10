import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { todoClient } from '../../client'
import { TaskComposerProvider } from '../components/TaskComposer'
import { WecomCalendarSync } from '../components/WecomCalendarSync'
import { ErrorState, LoadingState } from '../components/States'
import { AppShell } from './AppShell'
import { TodayPage } from '../pages/TodayPage'
import { PlanningPage } from '../pages/PlanningPage'
import { TasksPage } from '../pages/TasksPage'
import { CalendarPage } from '../pages/CalendarPage'
import { QuadrantsPage } from '../pages/QuadrantsPage'
import { ProjectsPage } from '../pages/ProjectsPage'
import { GoalsPage } from '../pages/GoalsPage'
import { RecurrencesPage } from '../pages/RecurrencesPage'
import { DataPage } from '../pages/DataPage'
import appIcon from '../assets/app-icon.png'

export function App() {
  const queryClient = useQueryClient()
  const [composerGeneration, setComposerGeneration] = useState(0)
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: todoClient.app.bootstrap, staleTime: Infinity })

  useEffect(() => {
    if (!bootstrap.data) return
    let lastEpoch = bootstrap.data.dataEpoch
    let lastRevision = bootstrap.data.revision ?? 0
    const unsubscribe = todoClient.app.subscribe((raw) => {
      const notice = raw as { dataEpoch?: string; revision?: number; tags?: string[]; databaseReplaced?: boolean }
      const epochChanged = Boolean(notice.dataEpoch && notice.dataEpoch !== lastEpoch)
      const jumped = typeof notice.revision === 'number' && notice.revision > lastRevision + 1
      if (epochChanged || notice.databaseReplaced) {
        lastEpoch = notice.dataEpoch
        lastRevision = notice.revision ?? 0
        queryClient.clear()
        setComposerGeneration((value) => value + 1)
        void queryClient.refetchQueries()
        return
      }
      if (typeof notice.revision === 'number' && notice.revision <= lastRevision) return
      lastRevision = notice.revision ?? lastRevision
      if (jumped || notice.tags?.includes('ALL')) {
        void queryClient.invalidateQueries()
        return
      }
      const keyByTag: Record<string, string[]> = {
        TODAY: ['today'], REVIEW: ['review'], PLANNING: ['planning'], TASKS: ['tasks'],
        CALENDAR: ['calendar'], QUADRANTS: ['quadrants'], PROJECTS: ['projects'],
        GOALS: ['goals'], RECURRENCES: ['recurrences'], SETTINGS: ['settings']
      }
      for (const tag of notice.tags ?? []) {
        const key = keyByTag[tag]
        if (key) void queryClient.invalidateQueries({ queryKey: key })
      }
    })
    return unsubscribe
  }, [bootstrap.data, queryClient])

  if (bootstrap.isLoading) {
    return <main className="launch-screen"><img className="brand-mark" src={appIcon} alt="" draggable={false} /><LoadingState label="正在打开你的任务空间…" /></main>
  }
  if (bootstrap.isError || !bootstrap.data) {
    return <main className="launch-screen"><img className="brand-mark" src={appIcon} alt="" draggable={false} /><ErrorState error={bootstrap.error} onRetry={() => bootstrap.refetch()} /></main>
  }

  return (
    <TaskComposerProvider key={composerGeneration} today={bootstrap.data.today}>
      <WecomCalendarSync today={bootstrap.data.today} />
      <Routes>
        <Route element={<AppShell today={bootstrap.data.today} appVersion={bootstrap.data.appVersion} />}>
          <Route index element={<Navigate replace to="/today" />} />
          <Route path="/today" element={<TodayPage today={bootstrap.data.today} />} />
          <Route path="/planning" element={<PlanningPage today={bootstrap.data.today} />} />
          <Route path="/tasks" element={<TasksPage today={bootstrap.data.today} />} />
          <Route path="/calendar" element={<CalendarPage today={bootstrap.data.today} />} />
          <Route path="/quadrants" element={<QuadrantsPage today={bootstrap.data.today} />} />
          <Route path="/projects" element={<ProjectsPage today={bootstrap.data.today} />} />
          <Route path="/goals" element={<GoalsPage today={bootstrap.data.today} />} />
          <Route path="/recurrences" element={<RecurrencesPage today={bootstrap.data.today} />} />
          <Route path="/data" element={<DataPage today={bootstrap.data.today} appVersion={bootstrap.data.appVersion} />} />
          <Route path="*" element={<Navigate replace to="/today" />} />
        </Route>
      </Routes>
    </TaskComposerProvider>
  )
}
