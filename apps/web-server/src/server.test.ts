/**
 * web-server 集成测试。使用 bun:test 自带 server。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadConfig } from './config'
import { createApp } from './app'
import { webEventBus } from './event-bus'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({
    port: 0, // 自动分配
    fetch: createApp(config).fetch,
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
})

describe('web-server /health', () => {
  test('返回 ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; kind: string }
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('web')
  })
})

describe('web-server /api/ipc', () => {
  test('已注册通道 runtime:get-status 返回 ready', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'runtime:get-status' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { status: string } }
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('ready')
  })

  test('未注册通道返回 PLATFORM_UNSUPPORTED', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'foo:bar' }),
    })
    expect(res.status).toBe(501)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
  })

  test('缺 channel 返回 BAD_REQUEST', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('chat:send-message 接入主进程 chat-service，错误情况下推 STREAM_ERROR', async () => {
    // 准备 conversation（避免主进程在 channelId 验证路径上导致某些侧走不开）
    const created = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'chat:create-conversation',
        args: ['server.test send-message'],
      }),
    }).then((r) => r.json()) as { ok: boolean; data: { id: string } }
    expect(created.ok).toBe(true)
    const conversationId = created.data.id

    const received: { channel: string; payload: unknown }[] = []
    const unsubs: Array<() => void> = []
    for (const ch of ['chat:stream:chunk', 'chat:stream:error', 'chat:stream:complete']) {
      unsubs.push(webEventBus.subscribe(ch, (event) => {
        received.push({ channel: event.channel, payload: event.data })
      }))
    }

    // 用不存在的 channelId 让 chat-service 走真实路径并推 STREAM_ERROR
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'chat:send-message',
        args: [{
          conversationId,
          userMessage: 'hello e2e',
          messageHistory: [],
          channelId: 'no-such-channel-id',
          modelId: 'no-such-model',
        }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { accepted: boolean; conversationId: string } }
    expect(body.ok).toBe(true)
    expect(body.data.accepted).toBe(false)
    expect(body.data.conversationId).toBe(conversationId)

    // 等待 chat-service.sendMessage 把 sink.send 推完
    await new Promise((r) => setTimeout(r, 100))
    unsubs.forEach((u) => u())

    const errorEvent = received.find((e) => e.channel === 'chat:stream:error')
    expect(errorEvent).toBeDefined()
    const errorPayload = errorEvent?.payload as { conversationId: string; error: string } | undefined
    expect(errorPayload?.conversationId).toBe(conversationId)
    expect(errorPayload?.error).toContain('渠道不存在')

    // 清理对话
    await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'chat:delete-conversation', args: [conversationId] }),
    })
  })

  test('window:minimize 等桌面专属能力抛 PlatformUnsupportedError', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'window:minimize' }),
    })
    expect(res.status).toBe(501)
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
    expect(body.error.message).toContain('window:minimize')
  })
})

describe('web-server 鉴权', () => {
  let authServer: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    const config = { ...loadConfig(), token: 'test-token-123' }
    authServer = Bun.serve({
      port: 0,
      fetch: createApp(config).fetch,
    })
  })
  afterAll(() => authServer.stop())

  test('无 token 时 401', async () => {
    const res = await fetch(`http://127.0.0.1:${authServer.port}/health`)
    expect(res.status).toBe(401)
  })

  test('正确 token 通过', async () => {
    const res = await fetch(`http://127.0.0.1:${authServer.port}/health?token=test-token-123`)
    expect(res.status).toBe(200)
  })

  test('错误 token 401', async () => {
    const res = await fetch(`http://127.0.0.1:${authServer.port}/health?token=wrong`)
    expect(res.status).toBe(401)
  })

  test('Bearer token 通过', async () => {
    const res = await fetch(`http://127.0.0.1:${authServer.port}/health`, {
      headers: { Authorization: 'Bearer test-token-123' },
    })
    expect(res.status).toBe(200)
  })
})