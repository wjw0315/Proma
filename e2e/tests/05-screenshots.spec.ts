/**
 * 用例 5：截图归档
 *
 * 主动对每个关键页面状态截图存到 e2e/screenshots/。
 * 单独的归档用例，便于单独触发 `bun run e2e:update` 更新 baseline。
 */

import { test, expect } from '../fixtures/test-base'

test.describe('E2E 5: 截图归档', () => {
  test('首屏截图', async ({ page, archiveScreenshot }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(500) // 等首屏动画
    const file = await archiveScreenshot('05-home-fullpage')
    expect(file).toMatch(/screenshots[\\/].+\.png$/)
  })

  test('暗色主题首屏截图', async ({ page, archiveScreenshot }) => {
    await page.goto('/')
    // 切到 dark：注入 localStorage 让主题系统读取
    await page.evaluate(() => {
      try {
        localStorage.setItem('proma:theme-mode', 'dark')
      }
      catch { /* ignore */ }
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(500)
    await archiveScreenshot('05-home-dark')
  })
})
