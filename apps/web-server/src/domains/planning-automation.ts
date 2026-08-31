/**
 * planning / automation domain：把 web-server IPC 通道接到主进程 lib 真实业务。
 *
 * 依赖链（planning-manager / automation-manager）零 Electron 依赖：
 * - planning-manager：node:crypto + node:sqlite（Bun 环境自动回退 bun:sqlite）
 * - automation-manager：node:crypto + safe-file（JSON 文件）
 *
 * 数据落盘与 Electron 主进程同一份：
 * - planning.db（SQLite，WAL）
 * - automations.json
 *
 * 本模块只接纯本地 CRUD；依赖 Electron runtime / Agent runtime 的通道
 * （start-todo-agent、native-sync 系列、run-now 触发调度）不在此注册，
 * 保持 PlatformUnsupportedError 由 web-shim 降级。
 */

import type { IpcHandler } from '../ipc-router'
import {
  listTodos as libListTodos,
  createTodo as libCreateTodo,
  updateTodo as libUpdateTodo,
  deleteTodo as libDeleteTodo,
  listCalendarEvents as libListCalendarEvents,
  createCalendarEvent as libCreateCalendarEvent,
  updateCalendarEvent as libUpdateCalendarEvent,
  deleteCalendarEvent as libDeleteCalendarEvent,
  listPlanningGroups as libListGroups,
  createPlanningGroup as libCreateGroup,
  updatePlanningGroup as libUpdateGroup,
  deletePlanningGroup as libDeleteGroup,
  listPlanningTags as libListTags,
  listActivePlanningReminders as libListActiveReminders,
  acknowledgePlanningReminder as libAcknowledgeReminder,
  snoozePlanningReminder as libSnoozeReminder,
} from '../../../electron/src/main/lib/planning-manager'
import {
  listAutomations as libListAutomations,
  createAutomation as libCreateAutomation,
  updateAutomation as libUpdateAutomation,
  deleteAutomation as libDeleteAutomation,
} from '../../../electron/src/main/lib/automation-manager'

/** 从 web-shim 的 args（位置参数数组或单值）取第 n 个参数。 */
function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

/** 校验非空字符串；返回原值或抛错。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

/** 与主进程 parseTodoListQuery 对齐的最小解析。 */
function parseTodoListQuery(input: unknown): Parameters<typeof libListTodos>[0] {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const query: Record<string, unknown> = {}
  if (raw.status === 'open' || raw.status === 'completed') query.status = raw.status
  if (typeof raw.limit === 'number' && raw.limit > 0) query.limit = Math.min(raw.limit, 100)
  if (typeof raw.dueBefore === 'number') query.dueBefore = raw.dueBefore
  return query as Parameters<typeof libListTodos>[0]
}

/** 与主进程 parseCalendarEventListQuery 对齐的最小解析。 */
function parseCalendarEventListQuery(input: unknown): Parameters<typeof libListCalendarEvents>[0] {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const query: Record<string, unknown> = {}
  if (typeof raw.startAt === 'number') query.startAt = raw.startAt
  if (typeof raw.endAt === 'number') query.endAt = raw.endAt
  if (typeof raw.limit === 'number' && raw.limit > 0) query.limit = Math.min(raw.limit, 100)
  return query as Parameters<typeof libListCalendarEvents>[0]
}

/** 注册 planning / automation 的全部纯本地 CRUD 通道。 */
export function registerPlanningAutomationDomains(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== planning: todos =====
  register('planning:list-todos', (args) => libListTodos(parseTodoListQuery(arg(args, 0))))
  register('planning:create-todo', (args) => libCreateTodo(arg(args, 0) as Parameters<typeof libCreateTodo>[0]))
  register('planning:update-todo', (args) => libUpdateTodo(arg(args, 0) as Parameters<typeof libUpdateTodo>[0]))
  register('planning:delete-todo', (args) => libDeleteTodo(requireString(arg(args, 0), 'id')))

  // ===== planning: calendar =====
  register('planning:list-calendar-events', (args) => libListCalendarEvents(parseCalendarEventListQuery(arg(args, 0))))
  register('planning:create-calendar-event', (args) => libCreateCalendarEvent(arg(args, 0) as Parameters<typeof libCreateCalendarEvent>[0]))
  register('planning:update-calendar-event', (args) => libUpdateCalendarEvent(arg(args, 0) as Parameters<typeof libUpdateCalendarEvent>[0]))
  register('planning:delete-calendar-event', (args) => libDeleteCalendarEvent(requireString(arg(args, 0), 'id')))

  // ===== planning: groups / tags =====
  register('planning:list-groups', (args) => libListGroups(arg(args, 0) as Parameters<typeof libListGroups>[0]))
  register('planning:create-group', (args) => libCreateGroup(arg(args, 0) as Parameters<typeof libCreateGroup>[0]))
  register('planning:update-group', (args) => libUpdateGroup(arg(args, 0) as Parameters<typeof libUpdateGroup>[0]))
  register('planning:delete-group', (args) => {
    const scope = requireString(arg(args, 0), 'scope')
    const id = requireString(arg(args, 1), 'id')
    return libDeleteGroup(scope as Parameters<typeof libDeleteGroup>[0], id)
  })
  register('planning:list-tags', () => libListTags())

  // ===== planning: reminders（读写；不触发桌面通知调度） =====
  register('planning:list-active-reminders', () => libListActiveReminders())
  register('planning:acknowledge-reminder', (args) => libAcknowledgeReminder(requireString(arg(args, 0), 'id')))
  register('planning:snooze-reminder', (args) => {
    const input = arg(args, 0) as { id?: unknown; minutes?: unknown } | undefined
    if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
    return libSnoozeReminder(requireString(input.id, 'id'), input.minutes as number)
  })

  // ===== automation =====
  register('automation:list', () => libListAutomations())
  register('automation:create', (args) => libCreateAutomation(arg(args, 0) as Parameters<typeof libCreateAutomation>[0]))
  register('automation:update', (args) => libUpdateAutomation(arg(args, 0) as Parameters<typeof libUpdateAutomation>[0]))
  register('automation:delete', (args) => libDeleteAutomation(requireString(arg(args, 0), 'id')))
  register('automation:toggle', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const active = arg(args, 1)
    if (typeof active !== 'boolean') throw new Error('active 必须是 boolean')
    return libUpdateAutomation({ id, active })
  })
}
