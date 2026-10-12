import { expect, test, type ElectronApplication } from '@playwright/test'
import { access, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertUsesOnlyLocalResources,
  closeTodoApp,
  createIsolatedLocalAppData,
  launchTodoApp,
  removeIsolatedLocalAppData,
  type RunningTodoApp
} from './helpers/electron-app'

test.describe.configure({ mode: 'serial' })

test('总览隐藏已完成子工作后，父工作处理提示仍然保留', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  try {
    running = await launchTodoApp(localAppData)
    const page = running.page
    await page.evaluate(async () => {
      const parent = await window.todoApi.tasks.create({ title: '待收尾父工作' })
      if (!parent.ok) throw new Error(parent.error.message)
      const child = await window.todoApi.tasks.createChild({ title: '最后一条子工作', parentId: parent.data.value.id, parentExpectedVersion: parent.data.value.version })
      if (!child.ok) throw new Error(child.error.message)
    })
    await page.getByRole('link', { name: '任务总览' }).click()
    const card = page.locator('article.task-card').filter({ hasText: '最后一条子工作' })
    await card.getByRole('button', { name: '标记完成', exact: true }).click()
    await expect(card).toHaveCount(0)
    const followup = page.getByRole('dialog', { name: '父工作还需要继续吗？' })
    await expect(followup).toBeVisible()
    await expect(followup.getByRole('button', { name: '稍后决定' })).toBeVisible()
    await expect(followup.getByRole('button', { name: '继续添加子工作' })).toBeVisible()
    await followup.getByRole('button', { name: '完成父工作', exact: true }).click()
    await expect(followup).not.toBeVisible()
    await expect(page.locator('article.task-card').filter({ hasText: '待收尾父工作' })).toHaveCount(0)
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('目标可以直接创建独立行动，并回顾近期完成', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  try {
    running = await launchTodoApp(localAppData)
    const page = running.page
    const goalId = await page.evaluate(async () => {
      const result = await window.todoApi.goals.create({ name: '成为 API 产品经理', priority: 'P0' })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.value.id
    })
    await page.getByRole('link', { name: '目标', exact: true }).click()
    await page.getByRole('button', { name: '＋ 添加行动' }).click()
    await expect(page.getByLabel('支撑目标')).toHaveValue(goalId)
    await expect(page.getByLabel('所属项目')).toHaveValue('')
    await page.getByLabel('任务标题').fill('设计 API 鉴权方案')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = page.locator('article.task-card').filter({ hasText: '设计 API 鉴权方案' })
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: '标记完成', exact: true }).click()
    await page.getByText('近期完成 · 近14天').click()
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: '创建下一步' }).click()
    await expect(page.getByLabel('支撑目标')).toHaveValue(goalId)
    await page.getByLabel('任务标题').fill('验证 API 权限边界')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.locator('article.task-card').filter({ hasText: '验证 API 权限边界' })).toBeVisible()
    await page.screenshot({ path: resolve(import.meta.dirname, '../../artifacts/e2e/goals-actions.png'), fullPage: true })
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('首次离线启动默认进入今日且仅使用隔离数据目录', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  try {
    running = await launchTodoApp(localAppData)
    await expect(running.page.getByRole('heading', { name: '今天要把什么做好？' })).toBeVisible()
    await expect(running.page.getByRole('link', { name: '今日' })).toHaveClass(/is-active/)
    await expect(running.page.getByText('本地数据已自动保存')).toBeVisible()
    await assertUsesOnlyLocalResources(running.page)

    const artifactDirectory = resolve(import.meta.dirname, '../../artifacts/e2e')
    await mkdir(artifactDirectory, { recursive: true })
    await running.page.screenshot({ path: join(artifactDirectory, 'today.png'), fullPage: true })

    await running.page.getByRole('link', { name: '日历' }).click()
    await expect(running.page.getByRole('grid', { name: '月日历' })).toBeVisible()
    await running.page.screenshot({ path: join(artifactDirectory, 'calendar.png'), fullPage: true })
    await running.page.getByRole('link', { name: '数据管理' }).click()
    await expect(running.page.getByRole('heading', { name: '企业微信日历' })).toBeVisible()
    await running.page.screenshot({ path: join(artifactDirectory, 'data.png'), fullPage: true })

    await expect.poll(async () => access(join(running!.productDataRoot, 'data', 'app.sqlite3')).then(() => true, () => false)).toBe(true)
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('快速添加今日任务后立即显示', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  try {
    running = await launchTodoApp(localAppData)
    const title = 'E2E 今日任务：确认当天交付'
    const quickInput = running.page.getByLabel('快速添加今日任务')
    await quickInput.fill(title)
    await quickInput.press('Enter')

    await expect(running.page.locator('article.task-card').filter({ hasText: title })).toBeVisible()
    await expect(quickInput).toHaveValue('')
    await expect(running.page.getByText('已加入今日清单')).toBeVisible()
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('关闭应用后使用同一隔离目录重开，任务仍然存在', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let firstRun: RunningTodoApp | null = null
  let secondRun: RunningTodoApp | null = null
  const title = 'E2E 持久化任务：重启后仍可见'
  try {
    firstRun = await launchTodoApp(localAppData)
    await firstRun.page.getByLabel('快速添加今日任务').fill(title)
    await firstRun.page.getByLabel('快速添加今日任务').press('Enter')
    await expect(firstRun.page.locator('article.task-card').filter({ hasText: title })).toBeVisible()
    await closeTodoApp(firstRun)
    firstRun = null

    secondRun = await launchTodoApp(localAppData)
    await expect(secondRun.page.locator('article.task-card').filter({ hasText: title })).toBeVisible()
  } finally {
    await closeTodoApp(firstRun)
    await closeTodoApp(secondRun)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('待分配任务排到今天后，今日、日历与第四象限指向同一任务', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  const title = 'E2E 待分配任务：整理迁移清单'
  try {
    running = await launchTodoApp(localAppData)
    const today = await readApplicationLocalDate(running.application)

    await running.page.getByRole('link', { name: '待分配' }).click()
    await running.page.getByRole('button', { name: '＋ 添加任务' }).click()
    await expect(running.page.getByRole('dialog', { name: '新建任务' })).toBeVisible()
    await running.page.getByLabel(/^任务标题/).fill(title)
    await running.page.getByRole('button', { name: '创建任务' }).click()
    const planningTask = running.page.locator('article.task-card').filter({ hasText: title })
    await expect(planningTask).toBeVisible()
    await expect(planningTask.locator('.date-label')).toHaveText('待分配')

    await planningTask.getByRole('button', { name: '日期' }).click()
    await planningTask.getByLabel('选择计划完成日').fill(today)
    await expect(planningTask).toHaveCount(0)

    await running.page.getByRole('link', { name: '今日' }).click()
    await expect(running.page.locator('article.task-card').filter({ hasText: title })).toBeVisible()

    await running.page.getByRole('link', { name: '日历' }).click()
    await expect(running.page.locator('.calendar-chip').filter({ hasText: title })).toHaveCount(1)

    await running.page.getByRole('link', { name: '四象限' }).click()
    const fourthQuadrant = running.page.locator('section.quadrant--gray')
    await expect(fourthQuadrant.getByRole('heading', { name: '不重要不紧急' })).toBeVisible()
    await expect(fourthQuadrant.locator('article.task-card').filter({ hasText: title })).toHaveCount(1)
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('四象限支持按住任务卡主体拖入其他象限', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  const title = 'E2E 拖拽任务：推进关键交付'
  try {
    running = await launchTodoApp(localAppData)
    await running.page.getByLabel('快速添加今日任务').fill(title)
    await running.page.getByLabel('快速添加今日任务').press('Enter')
    await running.page.getByRole('link', { name: '四象限' }).click()

    const source = running.page.locator('section.quadrant--gray')
    const destination = running.page.locator('section.quadrant--red .quadrant__body')
    const draggable = source.locator('.quadrant-task').filter({ hasText: title })
    await expect(draggable).toBeVisible()
    await draggable.dragTo(destination)

    await expect(running.page.locator('section.quadrant--red .quadrant-task').filter({ hasText: title })).toBeVisible()
    await expect(source.locator('.quadrant-task').filter({ hasText: title })).toHaveCount(0)
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

test('晨间复盘改期与今日四象限拖拽在重启后保留', async () => {
  const localAppData = await createIsolatedLocalAppData()
  let running: RunningTodoApp | null = null
  try {
    running = await launchTodoApp(localAppData)
    const fixture = await running.page.evaluate(async () => {
      const bootstrap = await window.todoApi.app.getBootstrap()
      if (!bootstrap.ok) throw new Error(bootstrap.error.message)
      const today = bootstrap.data.localDate
      const date = new Date(`${today}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() - 1)
      const yesterday = date.toISOString().slice(0, 10)
      const drafts = [
        { title: '确认今天的发布范围', plannedOn: today, important: true, urgent: true },
        { title: '推进长期项目', plannedOn: today, important: true },
        { title: '回复今日消息', plannedOn: today, urgent: true },
        { title: '整理项目资料', notes: '拖拽后保留这段备注', plannedOn: today },
        { title: '补齐昨日记录', plannedOn: yesterday }
      ]
      const ids: string[] = []
      for (const draft of drafts) {
        const result = await window.todoApi.tasks.create(draft)
        if (!result.ok) throw new Error(result.error.message)
        ids.push(result.data.value.id)
      }
      return { today, yesterday, movedId: ids[3]!, overdueId: ids[4]! }
    })
    let page = running.page
    const artifactDirectory = resolve(import.meta.dirname, '../../artifacts/e2e')
    await mkdir(artifactDirectory, { recursive: true })
    await expect(page.getByRole('region', { name: '重要且紧急象限' }).getByText('确认今天的发布范围')).toBeVisible()
    await expect(page.getByRole('region', { name: '重要不紧急象限' }).getByText('推进长期项目')).toBeVisible()
    await expect(page.getByRole('region', { name: '不重要但紧急象限' }).getByText('回复今日消息')).toBeVisible()
    await expect(page.getByRole('region', { name: '不重要不紧急象限' }).getByText('整理项目资料')).toBeVisible()

    await page.getByRole('button', { name: /开始复盘/ }).click()
    const review = page.getByRole('dialog', { name: '晨间复盘' })
    await expect(review.getByRole('button', { name: '移至今天' })).toBeVisible()
    await page.screenshot({ path: join(artifactDirectory, 'morning-review.png'), fullPage: true, animations: 'disabled' })
    await review.getByRole('button', { name: '移至今天' }).click()
    await expect(review.getByText('没有遗留事项。')).toBeVisible()
    await expect(review.getByText('补齐昨日记录')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(review).not.toBeVisible()
    await expect(page.getByRole('heading', { name: /遗留待处理/ })).toHaveCount(0)

    const source = page.getByRole('region', { name: '不重要不紧急象限' })
    const destination = page.getByRole('region', { name: '重要且紧急象限' })
    await source.locator('.task-card__main').filter({ hasText: '整理项目资料' }).dragTo(destination.locator('.quadrant__body'))
    await expect(destination.getByText('整理项目资料')).toBeVisible()
    await expect(source.getByText('整理项目资料')).toHaveCount(0)
    await expect(page.getByText('象限已调整', { exact: true })).toBeVisible()

    const persisted = await page.evaluate(async ({ movedId, overdueId }) => {
      const moved = await window.todoApi.tasks.getDetail({ id: movedId })
      const overdue = await window.todoApi.tasks.getDetail({ id: overdueId })
      if (!moved.ok || !overdue.ok) throw new Error('无法读取修改后的任务')
      return { moved: moved.data, overdue: overdue.data }
    }, fixture)
    expect(persisted.moved).toMatchObject({ plannedOn: fixture.today, important: true, urgent: true, notes: '拖拽后保留这段备注' })
    expect(persisted.overdue).toMatchObject({ plannedOn: fixture.today, isOverdue: false })
    expect(persisted.overdue.history).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'SCHEDULE', oldValue: fixture.yesterday, newValue: fixture.today })]))

    await page.getByRole('link', { name: '四象限', exact: true }).click()
    await expect(page.getByRole('region', { name: '重要且紧急象限' }).getByText('整理项目资料')).toBeVisible()
    await page.getByRole('link', { name: '今日', exact: true }).click()
    await expect(page.getByRole('heading', { name: '今天要把什么做好？' })).toBeVisible()
    await expect(page.locator('.quadrant-grid--today').getByText('整理项目资料')).toBeVisible()
    await page.getByRole('button', { name: '今天关闭复盘卡片' }).click()
    await expect(page.locator('.review-banner')).toHaveCount(0)
    const toastCloseButtons = page.getByRole('button', { name: '关闭提示' })
    while (await toastCloseButtons.count()) await toastCloseButtons.first().click()
    await page.screenshot({ path: join(artifactDirectory, 'today-quadrants.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: '列表', exact: true }).click()
    await expect(page.getByRole('region', { name: /象限$/ })).toHaveCount(0)
    await closeTodoApp(running)
    running = null

    running = await launchTodoApp(localAppData)
    page = running.page
    await expect(page.getByRole('button', { name: '列表', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('补齐昨日记录')).toBeVisible()
    await page.getByRole('button', { name: '四象限分组' }).click()
    await expect(page.getByRole('region', { name: '重要且紧急象限' }).getByText('整理项目资料')).toBeVisible()
    await expect(page.getByRole('region', { name: '不重要不紧急象限' }).getByText('补齐昨日记录')).toBeVisible()
  } finally {
    await closeTodoApp(running)
    await removeIsolatedLocalAppData(localAppData)
  }
})

async function readApplicationLocalDate(application: ElectronApplication): Promise<string> {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
    'window.todoApi.app.getBootstrap().then(result => result.ok ? result.data.localDate : Promise.reject(new Error(result.error.message)))'
  ))
}
