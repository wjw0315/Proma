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

  test('chat:send-message 立即返回 ok，并异步推 SSE delta chunk', async () => {
    const sessionId = `e2e-${Date.now()}`
    const received: { kind: string; content?: string }[] = []
    const unsub = webEventBus.subscribe(`chat:stream:${sessionId}`, (event) => {
      const data = event.data as { kind: string; content?: string }
      received.push(data)
    })

    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'chat:send-message',
        args: [{ sessionId, content: 'hello e2e' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { accepted: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.accepted).toBe(true)

    // 等待 setImmediate + publish 落盘
    await new Promise((r) => setTimeout(r, 100))
    unsub()

    const delta = received.find((e) => e.kind === 'delta')
    expect(delta).toBeDefined()
    expect(delta?.content).toBe('echo: hello e2e')
    const done = received.find((e) => e.kind === 'done')
    expect(done).toBeDefined()
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