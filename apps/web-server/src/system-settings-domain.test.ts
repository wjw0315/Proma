/**
 * 系统级设置 domain 的 IPC 集成测试（PR4 Bug3 D2）。
 *
 * 覆盖范围：
 * 1. web-server 自身 introspection（get-config / get-status / get-logs）：
 *    Web 形态下 web-server 即当前进程；从 env 推断 host/port/token。
 * 2. 桌面专属能力降级（app-icon / voice-dictation / storage / chat-resource 等）：
 *    不依赖 Electron runtime，抛 PlatformUnsupportedError。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-system-settings-test-${process.pid}`
// 让 config 稳定且可断言
process.env.PROMA_WEB_HOST = '127.0.0.1'
process.env.PROMA_WEB_PORT = '5774'
process.env.PROMA_WEB_TOKEN = 'test-token-pr4'
process.env.PROMA_WEB_REQUIRE_TOKEN = '0'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>
const TEST_TOKEN = process.env.PROMA_WEB_TOKEN!

async function ipcRaw(channel: string, args?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/ipc?token=${TEST_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })
}

async function ipc<T>(channel: string, args?: unknown): Promise<T> {
  const res = await ipcRaw(channel, args)
  const body = await res.json() as { ok: boolean; data?: T; error?: { message: string; code?: string } }
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
  // 清理测试进程设的环境变量,避免污染同进程后续测试文件(bun test 共享 process.env)
  delete process.env.PROMA_WEB_TOKEN
  delete process.env.PROMA_WEB_REQUIRE_TOKEN
})

describe('web-server 系统级设置 domain（PR4 Bug3 D2）', () => {
  test('web-server:get-config 返回当前进程配置（与 env 推断一致）', async () => {
    const cfg = await ipc<{ host: string; port: number; token: string | null; requireTokenOnPublic: boolean }>(
      'web-server:get-config',
    )
    expect(cfg.host).toBe(process.env.PROMA_WEB_HOST!)
    expect(cfg.port).toBe(Number(process.env.PROMA_WEB_PORT!))
    expect(cfg.token).toBe(process.env.PROMA_WEB_TOKEN!)
    expect(cfg.requireTokenOnPublic).toBe(false)
  })

  test('web-server:get-status 标记 running 且给出当前 pid 与 bindAddress', async () => {
    const status = await ipc<{ status: string; pid: number; bindAddress?: string }>('web-server:get-status')
    expect(status.status).toBe('running')
    expect(status.pid).toBe(process.pid)
    expect(status.bindAddress).toBe(`${process.env.PROMA_WEB_HOST}:${process.env.PROMA_WEB_PORT}`)
  })

  test('web-server:get-logs 返回 WebServerLogEntry 对象数组，limit 可控', async () => {
    const logs = await ipc<{ ts: number; stream: 'stdout' | 'stderr' | 'system'; message: string }[]>(
      'web-server:get-logs', []
    )
    expect(Array.isArray(logs)).toBe(true)
    expect(logs.length).toBe(50)
    for (const entry of logs) {
      expect(typeof entry.ts).toBe('number')
      expect(entry.stream).toBe('system')
      expect(typeof entry.message).toBe('string')
    }

    const limited = await ipc<unknown[]>('web-server:get-logs', [5])
    expect(limited.length).toBe(5)
  })
})

describe('web-server 系统级设置 domain 桌面专属能力降级（PR4 Bug3 D2）', () => {
  // web-server 自管理（不能 manage 当前进程）
  for (const ch of [
    'web-server:update-config',
    'web-server:start',
    'web-server:stop',
    'web-server:restart',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError`, async () => {
      const res = await ipcRaw(ch, [{ host: '0.0.0.0' }])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(ch)
    })
  }

  test('app-icon:set 抛 PlatformUnsupportedError（macOS Dock 桌面专属）', async () => {
    const res = await ipcRaw('app-icon:set', ['cyberpunk'])
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
    expect(body.error.message).toContain('Dock')
  })

  // 语音输入
  for (const ch of [
    'voice-dictation:get-settings',
    'voice-dictation:update-settings',
    'voice-dictation:test-connection',
    'voice-dictation:check-mic-permission',
    'voice-dictation:request-mic-permission',
    'voice-dictation:start',
    'voice-dictation:stop',
    'voice-dictation:toggle',
    'voice-dictation:preview',
    'voice-dictation:commit',
    'voice-dictation:send-audio',
    'voice-dictation:resize',
    'voice-dictation:hide',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError（safeStorage / 系统麦克风权限桌面专属）`, async () => {
      const res = await ipcRaw(ch, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain('voice-dictation')
    })
  }

  // 存储清理
  for (const ch of [
    'storage:get-stats',
    'storage:cleanup-temp',
    'storage:cleanup',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError（依赖 Electron app.getPath('temp')）`, async () => {
      const res = await ipcRaw(ch, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain('storage')
    })
  }

  test('chat:save-resource-file-as 抛 PlatformUnsupportedError（依赖 BrowserWindow + dialog）', async () => {
    const res = await ipcRaw('chat:save-resource-file-as', ['guide.png', 'guide.png'])
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
    expect(body.error.message).toContain('BrowserWindow')
  })
})
