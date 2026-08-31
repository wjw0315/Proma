/**
 * Playwright 全局配置。
 *
 * 关键决策：
 * - 使用系统已安装的 Google Chrome（channel: 'chrome'）而不是 playwright 内置 chromium
 *   避免首次安装时下载 ~150MB 二进制。如果未来 CI 需要内置浏览器，再加 projects。
 * - 单一 chromium project；视觉回归 baseline 按 OS 命名会落在同一目录（mac）。
 * - 不依赖 electronmon：start-dev 只起 vite + web-server。
 */

import { defineConfig, devices } from '@playwright/test'

const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // 串行跑，避免端口/进程干扰；后续可放开
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../playwright-report' }],
  ],
  outputDir: './test-results',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // 不录制 video：避免依赖 ffmpeg；需要时手动打开
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chrome-system',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome', // 用本机 Google Chrome
      },
    },
  ],
  webServer: {
    // Playwright 自带 webServer 命令管理；start-dev 会保持前台直到被 SIGTERM
    command: 'bun run e2e/harness/start-dev.ts',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: '..',  // 仓库根；web-server 路径相对 root
  },
})
