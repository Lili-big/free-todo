import { z } from 'zod'

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
}

export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

export const localDateSchema = z.string().refine(isValidLocalDate, '日期必须是有效的 YYYY-MM-DD')
export const entityIdSchema = z.string().uuid()
export const nullableEntityIdSchema = entityIdSchema.nullable()
export const titleSchema = z.string().trim().min(1, '标题不能为空').max(200, '标题最多 200 个字符')
export const notesSchema = z.string().max(10_000, '备注最多 10000 个字符').nullable()
export const expectedVersionSchema = z.number().int().positive()

export const taskStatusSchema = z.enum(['TODO', 'DONE', 'CANCELLED'])
export const projectStatusSchema = z.enum(['ACTIVE', 'COMPLETED'])
export const goalStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'REVIEW_REQUIRED', 'COMPLETED', 'ABANDONED'])
export const goalPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3'])

export const goalPeriodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NONE'), startOn: z.null(), endOn: z.null() }),
  z.object({ kind: z.enum(['MONTH', 'QUARTER', 'YEAR', 'CUSTOM']), startOn: localDateSchema, endOn: localDateSchema })
]).refine((period) => period.kind === 'NONE' || period.startOn <= period.endOn, '周期开始日不能晚于结束日')

export const recurrencePatternSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('DAILY'), weekdays: z.array(z.number()).max(0), monthlyDay: z.null() }),
  z.object({ kind: z.literal('WEEKLY'), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((days) => [...new Set(days)].sort()), monthlyDay: z.null() }),
  z.object({ kind: z.literal('MONTHLY'), weekdays: z.array(z.number()).max(0), monthlyDay: z.number().int().min(1).max(31) })
])

const externalCalendarRangeSchema = z.object({
  startOn: localDateSchema,
  endOn: localDateSchema
}).refine((value) => value.startOn <= value.endOn, '开始日不能晚于结束日')

const connectWecomCalendarSchema = z.object({
  server: z.string().trim().min(1, '服务器不能为空').max(2048, '服务器地址过长'),
  account: z.string().trim().min(1).max(512).optional(),
  username: z.string().trim().min(1).max(512).optional(),
  password: z.string().min(1, '密码不能为空').max(4096, '密码过长')
}).refine((value) => Boolean(value.account || value.username), {
  message: '账号或用户名至少填写一项',
  path: ['username']
})

const createTaskSchema = z.object({
  goalId: nullableEntityIdSchema.optional(),
  title: titleSchema,
  notes: notesSchema.optional(),
  plannedOn: localDateSchema.nullable().optional(),
  projectId: nullableEntityIdSchema.optional(),
  parentTaskId: nullableEntityIdSchema.optional(),
  important: z.boolean().optional(),
  urgent: z.boolean().optional()
})

const updateTaskContentSchema = z.object({
  goalId: nullableEntityIdSchema.optional(),
  id: entityIdSchema,
  expectedVersion: expectedVersionSchema,
  title: titleSchema.optional(),
  notes: notesSchema.optional(),
  important: z.boolean().optional(),
  urgent: z.boolean().optional()
}).refine((value) => Object.keys(value).some((key) => !['id', 'expectedVersion'].includes(key)), '至少提交一个变更字段')

export const ipcSchemas = {
  'app:bootstrap': z.undefined(),
  'app:reconcile': z.undefined(),
  'app:preferences': z.undefined(),
  'app:set-launch-at-login': z.object({ enabled: z.boolean() }),
  'today:snapshot': z.undefined(),
  'today:review-snapshot': z.undefined(),
  'today:dismiss-review': z.object({ expectedLocalDate: localDateSchema }),
  'today:finish-review': z.object({ expectedLocalDate: localDateSchema }),
  'planning:snapshot': z.undefined(),
  'tasks:list': z.object({ goalId: nullableEntityIdSchema.optional(), status: taskStatusSchema.or(z.literal('ALL')).optional(), projectId: nullableEntityIdSchema.optional(), parentId: nullableEntityIdSchema.optional(), search: z.string().max(200).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(500).optional() }),
  'tasks:detail': z.object({ id: entityIdSchema }),
  'tasks:create': createTaskSchema,
  'tasks:update-content': updateTaskContentSchema,
  'tasks:set-schedule': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, plannedOn: localDateSchema.nullable() }),
  'tasks:change-status': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, status: taskStatusSchema, confirmationToken: z.string().optional() }),
  'tasks:create-child': createTaskSchema.omit({ projectId: true, parentTaskId: true }).extend({ parentId: entityIdSchema, parentExpectedVersion: expectedVersionSchema }),
  'tasks:change-parent': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, parentId: nullableEntityIdSchema, confirmationToken: z.string().uuid().optional() }),
  'tasks:create-parent-and-attach': z.object({ childId: entityIdSchema, childExpectedVersion: expectedVersionSchema, title: titleSchema }),
  'tasks:move-tree': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, projectId: nullableEntityIdSchema, confirmationToken: z.string().optional() }),
  'tasks:create-next-step': createTaskSchema.omit({ projectId: true, parentTaskId: true }).extend({ sourceTaskId: entityIdSchema }),
  'calendar:range': z.object({ startOn: localDateSchema, endOn: localDateSchema, includeCancelled: z.boolean().optional() }).refine((value) => value.startOn <= value.endOn, '开始日不能晚于结束日'),
  'quadrants:snapshot': z.undefined(),
  'projects:list': z.undefined(),
  'projects:detail': z.object({ id: entityIdSchema }),
  'projects:create': z.object({ name: titleSchema, description: notesSchema.optional(), goalId: nullableEntityIdSchema.optional() }),
  'projects:update': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, name: titleSchema.optional(), description: notesSchema.optional(), goalId: nullableEntityIdSchema.optional() }),
  'projects:change-status': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, status: projectStatusSchema }),
  'projects:remove': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema }),
  'goal-categories:list': z.undefined(),
  'goal-categories:create': z.object({ name: titleSchema }),
  'goal-categories:rename': z.object({ id: entityIdSchema, name: titleSchema }),
  'goal-categories:remove': z.object({ id: entityIdSchema }),
  'goals:list': z.object({ status: goalStatusSchema.or(z.literal('ALL')).optional(), categoryId: nullableEntityIdSchema.optional(), priority: goalPrioritySchema.or(z.enum(['UNSET', 'ALL'])).optional() }),
  'goals:detail': z.object({ id: entityIdSchema }),
  'goals:create': z.object({ name: titleSchema, description: notesSchema.optional(), categoryId: nullableEntityIdSchema.optional(), priority: goalPrioritySchema.nullable().optional(), period: goalPeriodSchema.optional() }),
  'goals:update': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, name: titleSchema.optional(), description: notesSchema.optional(), categoryId: nullableEntityIdSchema.optional(), priority: goalPrioritySchema.nullable().optional(), period: goalPeriodSchema.optional() }),
  'goals:change-status': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, status: goalStatusSchema, period: goalPeriodSchema.optional(), confirmationToken: z.string().optional() }),
  'goals:remove': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema }),
  'recurrences:list': z.undefined(),
  'recurrences:detail': z.object({ id: entityIdSchema }),
  'recurrences:create': z.object({ title: titleSchema, notes: notesSchema.optional(), projectId: nullableEntityIdSchema.optional(), important: z.boolean().optional(), urgent: z.boolean().optional(), startOn: localDateSchema, endOn: localDateSchema.nullable().optional(), pattern: recurrencePatternSchema }),
  'recurrences:update': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, effectiveOn: localDateSchema, title: titleSchema.optional(), notes: notesSchema.optional(), projectId: nullableEntityIdSchema.optional(), important: z.boolean().optional(), urgent: z.boolean().optional(), startOn: localDateSchema.optional(), endOn: localDateSchema.nullable().optional(), pattern: recurrencePatternSchema.optional() }),
  'recurrences:set-enabled': z.object({ id: entityIdSchema, expectedVersion: expectedVersionSchema, effectiveOn: localDateSchema, enabled: z.boolean() }),
  'recurrences:apply-occurrence': z.object({
    seriesId: entityIdSchema,
    originalOccurrenceOn: localDateSchema,
    expectedSeriesRowVersion: expectedVersionSchema,
    appliedRuleVersionId: entityIdSchema,
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('COMPLETE') }),
      z.object({ kind: z.literal('CANCEL') }),
      z.object({ kind: z.literal('RESCHEDULE'), plannedOn: localDateSchema.nullable() }),
      z.object({ kind: z.literal('EDIT'), changes: z.object({ title: titleSchema.optional(), notes: notesSchema.optional(), important: z.boolean().optional(), urgent: z.boolean().optional(), projectId: nullableEntityIdSchema.optional() }) })
    ])
  }),
  'wecom-calendar:connect': connectWecomCalendarSchema,
  'wecom-calendar:disconnect': z.undefined(),
  'wecom-calendar:sync': externalCalendarRangeSchema,
  'wecom-calendar:status': z.undefined(),
  'wecom-calendar:range': externalCalendarRangeSchema,
  'backups:export': z.undefined(),
  'backups:inspect': z.undefined(),
  'backups:restore': z.object({ inspectionToken: z.string().min(1), confirmationToken: z.string().min(1) }),
  'backups:list-safety': z.undefined()
} as const

export type IpcChannel = keyof typeof ipcSchemas
