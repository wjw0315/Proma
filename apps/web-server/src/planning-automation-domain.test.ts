/**
 * planning / automation domain 的 IPC 集成测试。
 *
 * 通过 PROMA_CONFIG_DIR 隔离到临时目录，验证 CRUD 全链路
 * （web-server HTTP → ipc-router → 主进程 lib → SQLite / JSON）。
 *
 * 注意：本文件必须在最顶部（任何业务模块 import 之前）设置环境变量。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-planning-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

async function ipc<T>(channel: string, args?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })
  const body = await res.json() as { ok: boolean; data?: T; error?: { message: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'ipc failed')
  return body.data as T
}

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({ port: 0, fetch: createApp(config).fetch })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
  rmSync(process.env.PROMA_CONFIG_DIR!, { recursive: true, force: true })
})

interface TodoItem { id: string; title: string; status: string }
interface AutomationItem { id: string; name: string; active: boolean }

describe('web-server planning domain', () => {
  test('todo CRUD 闭环', async () => {
    // 创建
    const created = await ipc<TodoItem>('planning:create-todo', [{ title: 'web-server 测试 todo' }])
    expect(created.title).toBe('web-server 测试 todo')
    expect(created.status).toBe('open')

    // 列表（open 状态过滤）
    const open = await ipc<TodoItem[]>('planning:list-todos', [{ status: 'open' }])
    expect(open.some((t) => t.id === created.id)).toBe(true)

    // 更新
    const updated = await ipc<TodoItem>('planning:update-todo', [{ id: created.id, title: '改名后' }])
    expect(updated.title).toBe('改名后')

    // 删除
    const deleted = await ipc<boolean>('planning:delete-todo', [created.id])
    expect(deleted).toBe(true)
    const after = await ipc<TodoItem[]>('planning:list-todos', [{}])
    expect(after.some((t) => t.id === created.id)).toBe(false)
  })

  test('calendar event CRUD 闭环', async () => {
    const startAt = Date.now() + 3600_000
    const created = await ipc<{ id: string; title: string }>('planning:create-calendar-event', [{
      title: '测试日程', startAt,
    }])
    expect(created.title).toBe('测试日程')

    const events = await ipc<{ id: string }[]>('planning:list-calendar-events', [{
      startAt: startAt - 1000, endAt: startAt + 1000,
    }])
    expect(events.some((e) => e.id === created.id)).toBe(true)

    const updated = await ipc<{ title: string }>('planning:update-calendar-event', [{
      id: created.id, title: '改名日程',
    }])
    expect(updated.title).toBe('改名日程')

    expect(await ipc<boolean>('planning:delete-calendar-event', [created.id])).toBe(true)
  })

  test('groups list 起步为空、create 后可读', async () => {
    const initial = await ipc<unknown[]>('planning:list-groups', ['todo'])
    // 全新临时目录：默认组可能由 manager 初始化，只断言返回数组
    expect(Array.isArray(initial)).toBe(true)

    const group = await ipc<{ id: string; name: string }>('planning:create-group', [{ scope: 'todo', name: '测试组' }])
    expect(group.name).toBe('测试组')

    const tags = await ipc<unknown[]>('planning:list-tags')
    expect(Array.isArray(tags)).toBe(true)
  })

  test('list-active-reminders 返回数组', async () => {
    const reminders = await ipc<unknown[]>('planning:list-active-reminders')
    expect(Array.isArray(reminders)).toBe(true)
  })

  test('非法参数返回错误（create-todo 空 title）', async () => {
    await expect(ipc('planning:create-todo', [{ title: '' }])).rejects.toThrow()
  })
})

describe('web-server automation domain', () => {
  test('automation CRUD 闭环', async () => {
    const created = await ipc<AutomationItem>('automation:create', [{
      name: '测试自动化', prompt: '每分钟打个招呼', scheduleType: 'interval', intervalMinutes: 60,
    }])
    expect(created.name).toBe('测试自动化')

    const list = await ipc<AutomationItem[]>('automation:list')
    expect(list.some((a) => a.id === created.id)).toBe(true)

    // toggle 关闭
    const toggled = await ipc<AutomationItem>('automation:toggle', [created.id, false])
    expect(toggled.active).toBe(false)

    // 更新
    const updated = await ipc<AutomationItem>('automation:update', [{ id: created.id, name: '改名自动化' }])
    expect(updated?.name).toBe('改名自动化')

    expect(await ipc<boolean>('automation:delete', [created.id])).toBe(true)
  })

  test('automation:toggle 拒绝非 boolean active', async () => {
    const created = await ipc<AutomationItem>('automation:create', [{
      name: 'toggle 校验', prompt: 'x', scheduleType: 'interval', intervalMinutes: 60,
    }])
    await expect(ipc('automation:toggle', [created.id, 'yes'])).rejects.toThrow('boolean')
    await ipc<boolean>('automation:delete', [created.id])
  })
})
