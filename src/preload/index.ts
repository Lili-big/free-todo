import { contextBridge, ipcRenderer } from 'electron'
import type { TodoDesktopApi } from '../shared/api'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type { BackupProgressDto, ChangeNoticeDto } from '../shared/types'

const invoke = <T>(channel: string, input?: unknown): Promise<T> =>
  input === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, input)

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: TodoDesktopApi = {
  app: {
    getBootstrap: () => invoke(IPC_CHANNELS.APP_BOOTSTRAP),
    getPreferences: () => invoke(IPC_CHANNELS.APP_PREFERENCES),
    setLaunchAtLogin: (input) => invoke(IPC_CHANNELS.APP_SET_LAUNCH_AT_LOGIN, input),
    reconcile: () => invoke(IPC_CHANNELS.APP_RECONCILE),
    onChanged: (listener: (notice: ChangeNoticeDto) => void) => subscribe(IPC_EVENTS.CHANGED, listener),
    onDatabaseReplaced: (listener: (notice: ChangeNoticeDto) => void) => subscribe(IPC_EVENTS.DATABASE_REPLACED, listener)
  },
  today: {
    getSnapshot: () => invoke(IPC_CHANNELS.TODAY_SNAPSHOT),
    getReviewSnapshot: () => invoke(IPC_CHANNELS.TODAY_REVIEW),
    dismissReviewCard: (input) => invoke(IPC_CHANNELS.TODAY_DISMISS, input),
    finishReview: (input) => invoke(IPC_CHANNELS.TODAY_FINISH, input)
  },
  planning: {
    getSnapshot: () => invoke(IPC_CHANNELS.PLANNING_SNAPSHOT)
  },
  tasks: {
    list: (input = {}) => invoke(IPC_CHANNELS.TASKS_LIST, input),
    getDetail: (input) => invoke(IPC_CHANNELS.TASKS_DETAIL, input),
    create: (input) => invoke(IPC_CHANNELS.TASKS_CREATE, input),
    updateContent: (input) => invoke(IPC_CHANNELS.TASKS_UPDATE, input),
    setSchedule: (input) => invoke(IPC_CHANNELS.TASKS_SCHEDULE, input),
    changeStatus: (input) => invoke(IPC_CHANNELS.TASKS_STATUS, input),
    createChild: (input) => invoke(IPC_CHANNELS.TASKS_CREATE_CHILD, input),
    changeParent: (input) => invoke(IPC_CHANNELS.TASKS_CHANGE_PARENT, input),
    createParentAndAttach: (input) => invoke(IPC_CHANNELS.TASKS_CREATE_PARENT_AND_ATTACH, input),
    moveTree: (input) => invoke(IPC_CHANNELS.TASKS_MOVE_TREE, input),
    createNextStep: (input) => invoke(IPC_CHANNELS.TASKS_NEXT_STEP, input)
  },
  calendar: {
    getRange: (input) => invoke(IPC_CHANNELS.CALENDAR_RANGE, input)
  },
  quadrants: {
    getSnapshot: () => invoke(IPC_CHANNELS.QUADRANTS_SNAPSHOT)
  },
  projects: {
    list: () => invoke(IPC_CHANNELS.PROJECTS_LIST),
    getDetail: (input) => invoke(IPC_CHANNELS.PROJECTS_DETAIL, input),
    create: (input) => invoke(IPC_CHANNELS.PROJECTS_CREATE, input),
    update: (input) => invoke(IPC_CHANNELS.PROJECTS_UPDATE, input),
    changeStatus: (input) => invoke(IPC_CHANNELS.PROJECTS_STATUS, input),
    remove: (input) => invoke(IPC_CHANNELS.PROJECTS_REMOVE, input)
  },
  goalCategories: {
    list: () => invoke(IPC_CHANNELS.CATEGORIES_LIST),
    create: (input) => invoke(IPC_CHANNELS.CATEGORIES_CREATE, input),
    rename: (input) => invoke(IPC_CHANNELS.CATEGORIES_RENAME, input),
    remove: (input) => invoke(IPC_CHANNELS.CATEGORIES_REMOVE, input)
  },
  goals: {
    list: (input = {}) => invoke(IPC_CHANNELS.GOALS_LIST, input),
    getDetail: (input) => invoke(IPC_CHANNELS.GOALS_DETAIL, input),
    create: (input) => invoke(IPC_CHANNELS.GOALS_CREATE, input),
    update: (input) => invoke(IPC_CHANNELS.GOALS_UPDATE, input),
    changeStatus: (input) => invoke(IPC_CHANNELS.GOALS_STATUS, input),
    remove: (input) => invoke(IPC_CHANNELS.GOALS_REMOVE, input)
  },
  recurrences: {
    list: () => invoke(IPC_CHANNELS.RECURRENCES_LIST),
    getDetail: (input) => invoke(IPC_CHANNELS.RECURRENCES_DETAIL, input),
    create: (input) => invoke(IPC_CHANNELS.RECURRENCES_CREATE, input),
    updateFromDate: (input) => invoke(IPC_CHANNELS.RECURRENCES_UPDATE, input),
    setEnabledFromDate: (input) => invoke(IPC_CHANNELS.RECURRENCES_ENABLED, input),
    applyProjectedOccurrence: (input) => invoke(IPC_CHANNELS.RECURRENCES_APPLY, input)
  },
  wecomCalendar: {
    connect: (input) => invoke(IPC_CHANNELS.WECOM_CALENDAR_CONNECT, input),
    disconnect: () => invoke(IPC_CHANNELS.WECOM_CALENDAR_DISCONNECT),
    sync: (input) => invoke(IPC_CHANNELS.WECOM_CALENDAR_SYNC, input),
    getStatus: () => invoke(IPC_CHANNELS.WECOM_CALENDAR_STATUS),
    getRange: (input) => invoke(IPC_CHANNELS.WECOM_CALENDAR_RANGE, input)
  },
  backups: {
    exportInteractive: () => invoke(IPC_CHANNELS.BACKUPS_EXPORT),
    selectAndInspectRestore: () => invoke(IPC_CHANNELS.BACKUPS_INSPECT),
    restore: (input) => invoke(IPC_CHANNELS.BACKUPS_RESTORE, input),
    listSafetyBackups: () => invoke(IPC_CHANNELS.BACKUPS_LIST_SAFETY),
    onProgress: (listener: (progress: BackupProgressDto) => void) => subscribe(IPC_EVENTS.BACKUP_PROGRESS, listener)
  }
}

contextBridge.exposeInMainWorld('todoApi', api)
