import { app } from 'electron'
import { isAbsolute, join, normalize, parse } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'

const DATA_SLUG = 'personal-todo'

function assertLocalPath(candidate: string): string {
  const normalized = normalize(candidate)
  if (!isAbsolute(normalized) || normalized.startsWith('\\\\')) {
    throw new Error('应用数据目录必须位于本机磁盘。')
  }
  const root = parse(normalized).root
  if (!root || root.startsWith('\\\\')) {
    throw new Error('不支持将应用数据库放在网络路径。')
  }
  return normalized
}

export interface AppPaths {
  userData: string
  dataDir: string
  databaseFile: string
  restoreDir: string
  safetyBackupDir: string
  logsDir: string
  sessionDir: string
  integrationsDir: string
  wecomCalendarDir: string
}

export function configureAppPaths(): AppPaths {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error('无法解析 Windows LocalAppData 目录。')

  const userData = assertLocalPath(join(localAppData, DATA_SLUG))
  const dataDir = join(userData, 'data')
  const paths: AppPaths = {
    userData,
    dataDir,
    databaseFile: join(dataDir, 'app.sqlite3'),
    restoreDir: join(dataDir, '.restore'),
    safetyBackupDir: join(userData, 'backups', 'safety'),
    logsDir: join(userData, 'logs'),
    sessionDir: join(userData, 'session'),
    integrationsDir: join(userData, 'integrations'),
    wecomCalendarDir: join(userData, 'integrations', 'wecom-calendar')
  }

  for (const directory of [
    userData,
    dataDir,
    paths.restoreDir,
    paths.safetyBackupDir,
    paths.logsDir,
    paths.sessionDir,
    paths.integrationsDir,
    paths.wecomCalendarDir
  ]) {
    mkdirSync(directory, { recursive: true })
    const resolved = realpathSync.native(directory)
    assertLocalPath(resolved)
  }

  app.setPath('userData', userData)
  app.setPath('sessionData', paths.sessionDir)
  app.setPath('logs', paths.logsDir)
  return paths
}
