/**
 * 用例 4：Web 形态降级
 *
 * 验证：
 * - web-server 直接调 window:minimize 返回 501 + PLATFORM_UNSUPPORTED code
 * - web-bridge 正确识别 code，调用方拿到 PlatformUnsupportedError
 * - web-shim 的 safeRequest 捕获 PlatformUnsupportedError，降级为 placeholder（null）
 * - 浏览器侧调用 windowMinimize() 不抛错
 * - 视觉回归 baseline：降级后页面未崩
 */

import { test, expect } from '../fixtures/test-base'

test.describe('E2E 4: Web 形态降级', () => {
  test('直接访问 web-server：window:minimize 返回 501 + PLATFORM_UNSUPPORTED', async ({ page }) => {
    const res = await page.request.post('/api/ipc', {
      data: { channel: 'window:minimize', args: [] },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(501)
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
  })

  test('浏览器调用 windowMinimize：web-shim 降级不抛错', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(
      () => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI),
      null,
      { timeout: 15_000 },
    )

    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        electronAPI: { windowMinimize?: () => Promise<unknown> }
      }).electronAPI
      try {
        const r = await api.windowMinimize?.()
        return { ok: true, value: r }
      }
      catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })

    // web-shim 走完整链路：safeRequest → web-bridge.request → 抛 PlatformUnsupportedError →
    // safeRequest 捕获并降级为 placeholder。windowMinimize 不匹配 placeholder 任何模式 → null。
    expect(result.ok).toBe(true)
    expect(result.value).toBeNull()
  })

  test('窗口操作后页面未崩溃（视觉回归）', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(
      () => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI),
      null,
      { timeout: 15_000 },
    )
    await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { windowMinimize?: () => Promise<unknown> } }).electronAPI
      await api.windowMinimize?.() // 应静默降级，不抛错
    })
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
    await expect(page).toHaveScreenshot('04-platform-degradation.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    })
  })
})
