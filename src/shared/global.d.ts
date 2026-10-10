import type { TodoDesktopApi } from './api'

declare global {
  interface Window {
    todoApi: TodoDesktopApi
  }
}

export {}

