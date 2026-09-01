/**
 * 飞书 / 钉钉 / 企业微信 bridge domain 测试（PR7 Bug3 D6）。
 *
 * 覆盖范围：
 * 1. 只读（get-config / get-multi-config / get-status / get-multi-status / list-bindings）：
 *    web-only 简化版从 ~/.proma/{feishu,dingtalk,wechat}.json 直读，不解密安全字段。
 * 2. 大量降级（写 / 启动 / 凭据 / 网络）：抛 PlatformUnsupportedError。
 *
 * 注意：feishu.json / dingtalk.json / wechat.json 在测试 PROMA_CONFIG_DIR 下默认不存在，
 * 只读 handler 应该返回 fallback（空 config），不应该崩。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-bot-bridges-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config'
import { createApp } from './app'
import {
  getFeishuConfigPath,
  getDingTalkConfigPath,
  getWeChatConfigPath,
} from '../../electron/src/main/lib/config-paths'

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
})

describe('web-server 飞书只读（PR7 Bug3 D6）', () => {
  test('get-config 起步无文件时返回 enabled=false（不崩）', async () => {
    const cfg = await ipc<{ enabled: boolean; appId: string }>('feishu:get-config')
    expect(cfg.enabled).toBe(false)
    expect(cfg.appId).toBe('')
  })

  test('get-multi-config 起步无文件时返回空', async () => {
    const cfg = await ipc<{ bots?: unknown[] }>('feishu:get-multi-config')
    expect(cfg).toEqual({})
  })

  test('写入 v2 格式后 get-config / get-multi-config / get-status 读回', async () => {
    const feishuPath = getFeishuConfigPath()
    mkdirSync(join(feishuPath, '..'), { recursive: true })
    writeFileSync(feishuPath, JSON.stringify({
      version: 2,
      bots: [{
        id: 'bot-1', name: 'Test Bot', enabled: true,
        appId: 'cli_test', appSecret: 'enc:base64...', domain: 'feishu',
        defaultWorkspaceId: 'ws-1',
      }],
    }, null, 2))

    const single = await ipc<{ enabled: boolean; appId: string; appSecret: string }>('feishu:get-config')
    expect(single.enabled).toBe(true)
    expect(single.appId).toBe('cli_test')
    expect(single.appSecret).toBe('enc:base64...') // 加密态原样返回

    const multi = await ipc<{ bots?: unknown[] }>('feishu:get-multi-config')
    expect(multi.bots?.length).toBe(1)

    const status = await ipc<{ status: string; activeBindings: number }>('feishu:get-status')
    expect(status.status).toBe('configured')
    expect(status.activeBindings).toBe(0)

    const multiStatus = await ipc<{ botId: string; status: string }[]>('feishu:get-multi-status')
    expect(multiStatus[0]?.botId).toBe('bot-1')
    expect(multiStatus[0]?.status).toBe('configured')
  })

  test('list-bindings 始终返回空（运行时态静态读不到）', async () => {
    const bindings = await ipc<unknown[]>('feishu:list-bindings')
    expect(bindings).toEqual([])
  })
})

describe('web-server 钉钉只读（PR7 Bug3 D6）', () => {
  test('get-config 起步无文件时返回 enabled=false', async () => {
    const cfg = await ipc<{ enabled: boolean }>('dingtalk:get-config')
    expect(cfg.enabled).toBe(false)
  })

  test('写入多 bot 格式后 get-config / get-multi-config / get-status 读回', async () => {
    const dtPath = getDingTalkConfigPath()
    mkdirSync(join(dtPath, '..'), { recursive: true })
    writeFileSync(dtPath, JSON.stringify({
      bots: {
        'bot-1': { id: 'bot-1', name: '钉钉 1', enabled: true, clientId: 'cli_dt' },
      },
    }, null, 2))

    const single = await ipc<{ enabled: boolean; clientId?: string; bots?: Record<string, unknown> }>('dingtalk:get-config')
    expect(single.enabled).toBe(true)
    expect(single.clientId).toBe('cli_dt')
    expect(single.bots?.['bot-1']).toBeTruthy()

    const multi = await ipc<{ bots?: Record<string, unknown> }>('dingtalk:get-multi-config')
    expect(Object.keys(multi.bots ?? {}).length).toBe(1)

    const status = await ipc<{ status: string; activeBots: number }>('dingtalk:get-status')
    expect(status.status).toBe('configured')
    expect(status.activeBots).toBe(1)
  })
})

describe('web-server 企业微信只读（PR7 Bug3 D6）', () => {
  test('get-config 起步无文件时返回空', async () => {
    const cfg = await ipc<{ enabled?: boolean; credentials?: unknown }>('wechat:get-config')
    expect(cfg.enabled).toBeUndefined()
    expect(cfg.credentials).toBeUndefined()
  })

  test('写入后 get-config / get-status 读回（credentials 保持加密态）', async () => {
    const wcPath = getWeChatConfigPath()
    mkdirSync(join(wcPath, '..'), { recursive: true })
    writeFileSync(wcPath, JSON.stringify({
      enabled: true,
      credentials: { botToken: 'enc:base64token', ilinkBotId: 'bot@im.wechat' },
    }, null, 2))

    const cfg = await ipc<{ enabled: boolean; credentials: { botToken: string } }>('wechat:get-config')
    expect(cfg.enabled).toBe(true)
    expect(cfg.credentials.botToken).toBe('enc:base64token') // 加密态原样

    const status = await ipc<{ status: string }>('wechat:get-status')
    expect(status.status).toBe('configured')
  })
})

describe('web-server 飞书 / 钉钉 / 企业微信 启动/写/网络/凭据 降级（PR7 Bug3 D6）', () => {
  // 飞书
  for (const ch of [
    'feishu:save-config', 'feishu:save-bot-config', 'feishu:remove-bot',
    'feishu:start-bot', 'feishu:stop-bot',
    'feishu:test-connection', 'feishu:update-binding', 'feishu:remove-binding',
    'feishu:register-app-start', 'feishu:register-app-qrcode', 'feishu:register-app-status', 'feishu:register-app-cancel',
    'feishu:get-decrypted-secret', 'feishu:get-bot-decrypted-secret', 'feishu:report-presence',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError（飞书桌面专属）`, async () => {
      const res = await ipcRaw(ch, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(ch)
    })
  }

  // 钉钉
  for (const ch of [
    'dingtalk:save-config', 'dingtalk:save-bot-config', 'dingtalk:remove-bot',
    'dingtalk:start-bridge', 'dingtalk:stop-bridge',
    'dingtalk:start-bot', 'dingtalk:stop-bot',
    'dingtalk:test-connection', 'dingtalk:get-decrypted-secret', 'dingtalk:get-bot-decrypted-secret',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError（钉钉桌面专属）`, async () => {
      const res = await ipcRaw(ch, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(ch)
    })
  }

  // 企业微信
  for (const ch of [
    'wechat:start-bridge', 'wechat:stop-bridge', 'wechat:start-login', 'wechat:logout',
  ]) {
    test(`${ch} 抛 PlatformUnsupportedError（企业微信桌面专属）`, async () => {
      const res = await ipcRaw(ch, [])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(ch)
    })
  }
})
