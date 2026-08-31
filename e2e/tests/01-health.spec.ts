/**
 * 用例 1：健康检查
 * - /health 直接打到 web-server 5174 返回 {ok:true, kind:'web'}
 * - vite 5173 把 /api/ipc 反代到 web-server 5174，POST 应返回 ok
 * - 浏览器访问 vite 首页加载成功（document.title 非空）
 * - 截图归档
 */

import { request } from '@playwright/test'
import { test, expect } from '../fixtures/test-base'

const WEB_SERVER_URL = 'http://127.0.0.1:5174'

test.describe('E2E 1: 健康检查', () => {
  test('web-server /health 返回 ok', async () => {
    const ctx = await request.newContext({ baseURL: WEB_SERVER_URL })
    const res = await ctx.get('/health')
    expect(res.status()).toBe(200)
    const body = await res.json() as { ok: boolean; kind: string; ts: number }
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('web')
    expect(typeof body.ts).toBe('number')
    await ctx.dispose()
  })

  test('vite 反代 /api/ipc 可达 web-server', async ({ page }) => {
    const res = await page.request.post('/api/ipc', {
      data: { channel: 'runtime:get-status' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json() as { ok: boolean; data: { status: string } }
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('ready')
  })

  test('浏览器访问首页加载成功', async ({ page, archiveScreenshot }) => {
    await page.goto('/')
    // 等待 vite + react 首屏渲染：document.title 被设置
    await page.waitForFunction(() => document.title.length > 0, null, { timeout: 15_000 })
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)

    await archiveScreenshot('01-home')
  })
})
