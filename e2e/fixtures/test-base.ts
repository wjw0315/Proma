/**
 * 共享 fixture：
 * - 自动等待 web-server /health 200
 * - 提供 baseURL 已经配置好的 page
 * - 提供 helpers：archiveScreenshot(name)
 */

import { test as base, expect, type Page, request } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCREENSHOTS_DIR = join(__dirname, '..', 'screenshots')
const WEB_SERVER_URL = 'http://127.0.0.1:5174'

export interface TestHelpers {
  page: Page
  archiveScreenshot(name: string): Promise<string>
}

export const test = base.extend<TestHelpers>({
  page: async ({ page }, use) => {
    // 每次用例开始前确认 web-server 直接就绪（vite 不代理 /health，所以直打 5174）
    const ctx = await request.newContext({ baseURL: WEB_SERVER_URL })
    const healthRes = await ctx.get('/health').catch(() => null)
    await ctx.dispose()
    if (!healthRes || healthRes.status() !== 200) {
      throw new Error(`web-server ${WEB_SERVER_URL}/health 未就绪；harness 启动可能失败`)
    }
    await use(page)
  },
  archiveScreenshot: async ({ page }, use) => {
    const fn = async (name: string): Promise<string> => {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true })
      const file = join(SCREENSHOTS_DIR, `${name}.png`)
      await page.screenshot({ path: file, fullPage: true })
      return file
    }
    await use(fn)
  },
})

export { expect }
export { SCREENSHOTS_DIR }
