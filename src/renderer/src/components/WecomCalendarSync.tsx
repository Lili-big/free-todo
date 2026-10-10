import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { todoClient } from '../../client'
import { addDays } from '../utils/date'

const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1_000
const AUTO_SYNC_THROTTLE_MS = 60 * 1_000

let automaticSync: Promise<void> | null = null
let lastAutomaticSyncAt = 0

export function WecomCalendarSync({ today }: { today: string }) {
  const queryClient = useQueryClient()

  useEffect(() => {
    let disposed = false
    const sync = async () => {
      if (disposed || automaticSync || Date.now() - lastAutomaticSyncAt < AUTO_SYNC_THROTTLE_MS) return
      automaticSync = (async () => {
        try {
          const status = await todoClient.wecomCalendar.status()
          queryClient.setQueryData(['wecom-calendar', 'status'], status)
          if (!status.connected) return
          const result = await todoClient.wecomCalendar.sync(addDays(today, -35), addDays(today, 370))
          lastAutomaticSyncAt = Date.now()
          queryClient.setQueryData(['wecom-calendar', 'status'], result.status)
          await queryClient.invalidateQueries({ queryKey: ['wecom-calendar', 'range'] })
        } catch {
          // Automatic refresh stays quiet. The connection card exposes errors
          // and cached events remain available when the network is unavailable.
          await queryClient.invalidateQueries({ queryKey: ['wecom-calendar', 'status'] })
        } finally {
          automaticSync = null
        }
      })()
      await automaticSync
    }

    void sync()
    const onFocus = () => void sync()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void sync()
    }
    const interval = window.setInterval(() => void sync(), AUTO_SYNC_INTERVAL_MS)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [queryClient, today])

  return null
}
