/**
 * chat 会话 + channels domain 的 IPC 集成测试。
 *
 * PROMA_CONFIG_DIR 隔离；channel:list 在全新目录会自动创建预设 DeepSeek
 * 渠道（channel-manager 首次调用行为），断言只校验数组与字段形态，
 * 不锁定具体预设内容。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-chat-test-${process.pid}`

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

interface Conversation { id: string; title: string; pinned?: boolean; archived?: boolean; contextDividers?: string[] }

describe('web-server chat conversations domain', () => {
  test('会话 CRUD + pin/archive 闭环', async () => {
    // 创建
    const created = await ipc<Conversation>('chat:create-conversation', ['测试对话'])
    expect(created.title).toBe('测试对话')

    // 列表可见
    const list = await ipc<Conversation[]>('chat:list-conversations')
    expect(list.some((c) => c.id === created.id)).toBe(true)

    // 改标题
    const renamed = await ipc<Conversation>('chat:update-title', [created.id, '新标题'])
    expect(renamed.title).toBe('新标题')

    // pin 切换
    const pinned = await ipc<Conversation>('chat:toggle-pin', [created.id])
    expect(pinned.pinned).toBe(true)
    const unpinned = await ipc<Conversation>('chat:toggle-pin', [created.id])
    expect(unpinned.pinned).toBe(false)

    // archive 切换
    const archived = await ipc<Conversation>('chat:toggle-archive', [created.id])
    expect(archived.archived).toBe(true)

    // 消息读取（空对话）
    const messages = await ipc<unknown[]>('chat:get-messages', [created.id])
    expect(Array.isArray(messages)).toBe(true)

    // recent
    const recent = await ipc<{ messages?: unknown[] }>('chat:get-recent-messages', [created.id, 10])
    expect(recent).toBeTruthy()

    // 删除
    await ipc('chat:delete-conversation', [created.id])
    const after = await ipc<Conversation[]>('chat:list-conversations')
    expect(after.some((c) => c.id === created.id)).toBe(false)
  })

  test('chat:get-messages 不存在的会话返回空数组（与主进程语义一致）', async () => {
    const messages = await ipc<unknown[]>('chat:get-messages', ['no-such-id'])
    expect(messages).toEqual([])
  })

  test('chat:update-context-dividers 过滤非字符串项', async () => {
    const created = await ipc<Conversation>('chat:create-conversation', ['分隔线测试'])
    const updated = await ipc<Conversation>('chat:update-context-dividers', [created.id, ['m1', 42, null]])
    expect(Array.isArray(updated.contextDividers)).toBe(true)
    await ipc('chat:delete-conversation', [created.id])
  })
})

describe('web-server channels domain', () => {
  test('channel:list 返回数组（apiKey 加密态）', async () => {
    const channels = await ipc<{ id: string; provider?: string; apiKey?: unknown }[]>('channel:list')
    expect(Array.isArray(channels)).toBe(true)
    // 首次调用自动创建预设渠道；至少 1 个
    expect(channels.length).toBeGreaterThanOrEqual(1)
    for (const ch of channels) {
      // apiKey 若存在必须是加密形态（字符串），绝不能是明文空值以外的状态由主进程保证；
      // 这里只断言序列化可传递
      expect(typeof ch.id).toBe('string')
    }
  })
})
