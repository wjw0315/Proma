/**
 * settings domain 的 IPC 集成测试。
 *
 * 通过 PROMA_CONFIG_DIR 环境变量把配置目录隔离到临时目录，
 * 避免读写真实 ~/.proma/settings.json。
 *
 * 注意：本文件必须在最顶部（任何业务模块 import 之前）设置环境变量。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({
    port: 0,
    fetch: createApp(config).fetch,
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
  // 清理临时配置目录
  rmSync(process.env.PROMA_CONFIG_DIR!, { recursive: true, force: true })
})

describe('web-server settings domain', () => {
  test('settings:get 返回默认设置（首次无文件）', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:get' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { themeMode: string; onboardingCompleted: boolean } }
    expect(body.ok).toBe(true)
    expect(typeof body.data.themeMode).toBe('string')
    expect(body.data.onboardingCompleted).toBe(false)
  })

  test('settings:update 落盘并可再次读取', async () => {
    const updates = { onboardingCompleted: true, themeMode: 'dark' }
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:update', args: [updates] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { themeMode: string; onboardingCompleted: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.themeMode).toBe('dark')
    expect(body.data.onboardingCompleted).toBe(true)

    // 确认写到了隔离目录而不是真实 ~/.proma
    const settingsPath = `${process.env.PROMA_CONFIG_DIR}/settings.json`
    expect(existsSync(settingsPath)).toBe(true)
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { themeMode: string }
    expect(raw.themeMode).toBe('dark')

    // 再次 get 读到更新后的值
    const res2 = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:get' }),
    })
    const body2 = await res2.json() as { data: { themeMode: string } }
    expect(body2.data.themeMode).toBe('dark')
  })

  test('settings:update 拒绝非对象参数', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:update', args: ['not-an-object'] }),
    })
    expect(res.status).toBe(500)
    const body = await res.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('Partial<AppSettings>')
  })

  test('settings:update 兼容无数组包装的单参（直连调用方）', async () => {
    const res = await fetch(`${baseUrl}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:update', args: { themeMode: 'light' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { themeMode: string } }
    expect(body.data.themeMode).toBe('light')
  })
})
