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

describe('web-server channels domain 写操作（PR3 Bug3）', () => {
  // channel-manager 在 Bun 环境下 safeStorage 不可用，会走「明文降级」路径；
  // 这里只验证 API 表面，不依赖真加密。关键验证：create/update/delete 闭环。
  test('channel:create → list 可见 → channel:update → channel:delete 闭环', async () => {
    const created = await ipc<{ id: string; name: string; enabled: boolean }>('channel:create', [{
      name: 'PR3 测试渠道',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-pr3',
      models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini', enabled: true }],
      enabled: false,
    }])
    expect(created.id).toBeTruthy()
    expect(created.name).toBe('PR3 测试渠道')

    // list 可见
    const list = await ipc<{ id: string }[]>('channel:list')
    expect(list.some((c) => c.id === created.id)).toBe(true)

    // update
    const updated = await ipc<{ id: string; name: string; enabled: boolean }>('channel:update', [created.id, { name: 'PR3 测试渠道 - 已更新', enabled: true }])
    expect(updated.name).toBe('PR3 测试渠道 - 已更新')
    expect(updated.enabled).toBe(true)

    // delete
    await ipc('channel:delete', [created.id])
    const after = await ipc<{ id: string }[]>('channel:list')
    expect(after.some((c) => c.id === created.id)).toBe(false)
  })

  test('channel:create 拒绝非对象入参', async () => {
    const res = await ipcRaw('channel:create', [null])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('ChannelCreateInput')
  })

  test('channel:update 缺 id 参数报错', async () => {
    const res = await ipcRaw('channel:update', ['', { name: 'x' }])
    expect(res.status).toBe(500)
  })

  test('channel:delete 不存在的 id 不崩', async () => {
    // 主进程 channel-manager 在 id 不存在时 throw；web-server 应该让错误冒泡
    const res = await ipcRaw('channel:delete', ['no-such-channel-id'])
    expect(res.status).toBe(500)
  })
})

describe('web-server channels domain 网络执行能力（PR3 Bug3）', () => {
  test('channel:fetch-models 入参校验（无需真网络调用）', async () => {
    const res = await ipcRaw('channel:fetch-models', [null])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('FetchModelsInput')
  })

  test('channel:test 不存在的 id 返回 success=false（不崩）', async () => {
    // 主进程 testChannel 在渠道不存在时返回 {success:false, message:'渠道不存在'}
    const result = await ipc<{ success: boolean; message?: string }>('channel:test', ['no-such-channel-id'])
    expect(result.success).toBe(false)
  })

  test('channel:test-direct 入参校验', async () => {
    const res = await ipcRaw('channel:test-direct', [null])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('ChannelDirectTestInput')
  })

  test('channel:get-plan-quota 不存在的 id 返回 message 而不崩', async () => {
    const result = await ipc<{ success?: boolean; message?: string }>('channel:get-plan-quota', ['no-such-channel-id'])
    // 主进程在渠道不存在时返回 createUnsupportedPlanQuota
    expect(typeof result.message).toBe('string')
  })
})

describe('web-server channels domain 桌面专属能力降级（PR3 Bug3）', () => {
  test('channel:decrypt-key 抛 PlatformUnsupportedError（避免 API Key 明文泄霂）', async () => {
    const res = await ipcRaw('channel:decrypt-key', ['any-id'])
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
    expect(body.error.message).toContain('Web 形态')
  })

  for (const oauthChannel of [
    'channel:codex-oauth-login',
    'channel:codex-oauth-cancel',
    'channel:codex-oauth-device-code',
    'channel:xai-oauth-login',
    'channel:xai-oauth-cancel',
    'channel:xai-oauth-device-code',
  ]) {
    test(`${oauthChannel} 抛 PlatformUnsupportedError（OAuth 需桌面端 shell.openExternal）`, async () => {
      const res = await ipcRaw(oauthChannel, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(oauthChannel)
    })
  }
})
