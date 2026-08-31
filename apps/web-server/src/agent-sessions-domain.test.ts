/**
 * agent 会话/工作区 domain（只读）的 IPC 集成测试。
 *
 * 通过 PROMA_CONFIG_DIR 隔离到临时目录；会话/工作区数据目录由
 * agent-workspace-manager 基于 config 目录派生，同样落在临时目录内。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-agent-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

async function ipcRaw(channel: string, args?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })
}

async function ipc<T>(channel: string, args?: unknown): Promise<T> {
  const res = await ipcRaw(channel, args)
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

describe('web-server agent sessions domain（只读）', () => {
  test('agent:list-workspaces 返回数组（隔离目录起步为空）', async () => {
    const list = await ipc<unknown[]>('agent:list-workspaces')
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBe(0)
  })

  test('agent:list-sessions / active / archived / count 返回一致', async () => {
    const all = await ipc<unknown[]>('agent:list-sessions')
    const active = await ipc<unknown[]>('agent:list-active-sessions')
    const archived = await ipc<unknown[]>('agent:list-archived-sessions')
    const count = await ipc<number>('agent:count-archived-sessions')
    expect(Array.isArray(all)).toBe(true)
    expect(active.length).toBe(0)
    expect(archived.length).toBe(0)
    expect(count).toBe(0)
  })

  test('agent:get-sdk-messages 拒绝空 sessionId', async () => {
    const res = await ipcRaw('agent:get-sdk-messages', [''])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('必填')
  })

  test('agent:get-sdk-messages 不存在的会话返回空数组或报错（不崩）', async () => {
    // 两种实现均可接受：主进程语义是返回 []
    const res = await ipcRaw('agent:get-sdk-messages', ['nonexistent-session-id'])
    expect([200, 500]).toContain(res.status)
  })

  test('agent:get-workspace-capabilities 拒绝不存在的工作区', async () => {
    const res = await ipcRaw('agent:get-workspace-capabilities', ['no-such-slug'])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('不存在')
  })
})

describe('web-server agent 会话写操作', () => {
  test('create / update-title / toggle-pin / toggle-archive / delete 闭环', async () => {
    // 创建
    const created = await ipc<{ id: string; title: string }>('agent:create-session', ['写操作测试'])
    expect(created.title).toBe('写操作测试')

    // 列表可见
    const list = await ipc<{ id: string }[]>('agent:list-sessions')
    expect(list.some((s) => s.id === created.id)).toBe(true)

    // 改名
    const renamed = await ipc<{ title: string }>('agent:update-title', [created.id, '改名会话'])
    expect(renamed.title).toBe('改名会话')

    // pin / archive 切换
    const pinned = await ipc<{ pinned: boolean }>('agent:toggle-pin', [created.id])
    expect(pinned.pinned).toBe(true)
    const archived = await ipc<{ archived: boolean }>('agent:toggle-archive', [created.id])
    expect(archived.archived).toBe(true)

    // 删除
    await ipc('agent:delete-session', [created.id])
    const after = await ipc<{ id: string }[]>('agent:list-sessions')
    expect(after.some((s) => s.id === created.id)).toBe(false)
  })

  test('create-session 拒绝非 boolean isDraft', async () => {
    const res = await ipcRaw('agent:create-session', ['x', undefined, undefined, undefined, 'yes'])
    expect(res.status).toBe(500)
  })

  test('toggle-pin 拒绝不存在的会话', async () => {
    const res = await ipcRaw('agent:toggle-pin', ['no-such-id'])
    expect(res.status).toBe(500)
  })

  test('update-session-model 更新 channel/model', async () => {
    const created = await ipc<{ id: string }>('agent:create-session', ['模型测试'])
    const updated = await ipc<{ channelId?: string; modelId?: string }>('agent:update-session-model', [created.id, 'ch-1', 'model-x'])
    expect(updated.channelId).toBe('ch-1')
    expect(updated.modelId).toBe('model-x')
    await ipc('agent:delete-session', [created.id])
  })
})
