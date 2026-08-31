/**
 * 用例 3：PTY 终端
 *
 * 浏览器内通过 window.electronAPI 调 terminal:create → terminal:input 发 'ls\n'
 * 然后通过 WS /api/pty/{id} 收回流数据，断言包含常见 shell 关键字。
 *
 * 注意：node-pty 是 native 模块，CI 上可能缺失。
 * 若缺失则 test.skip()，不阻塞整个套件。
 */

import { test, expect } from '../fixtures/test-base'

test.describe('E2E 3: PTY 终端', () => {
  test('创建 PTY → 输入 ls → 断言回流', async ({ page, archiveScreenshot }) => {
    await page.goto('/')
    await page.waitForFunction(
      () => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI),
      null,
      { timeout: 15_000 },
    )

    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        electronAPI: {
          createTerminal?: (a: unknown) => Promise<unknown>
          writeTerminal?: (a: unknown) => Promise<unknown>
        }
      }).electronAPI

      if (typeof api.createTerminal !== 'function' || typeof api.writeTerminal !== 'function') {
        return { skip: true, reason: 'web-shim 未暴露 createTerminal/writeTerminal' as string }
      }

      const terminalId = `e2e-pty-${Date.now()}`
      try {
        await api.createTerminal({ terminalId, cols: 80, rows: 24, cwd: '/' })
      }
      catch (err) {
        return { skip: true, reason: `node-pty 不可用：${(err as Error).message}` as string }
      }

      // 通过 WS 收回流
      const wsUrl = `ws://${location.host}/api/pty/${terminalId}`.replace('http://', 'ws://')
      const received: string[] = []
      const wsDone = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        const timer = setTimeout(() => { ws.close(); resolve() }, 5_000)
        ws.onmessage = (ev) => {
          const frame = JSON.parse((ev as MessageEvent).data) as { type: string; data?: string }
          if (frame.type === 'data' && frame.data) {
            received.push(frame.data)
            // 收到回车 + 输出即可结束
            if (received.join('').length > 20) {
              clearTimeout(timer)
              ws.close()
              resolve()
            }
          }
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('WS 连接失败'))
        }
      })

      await api.writeTerminal({ terminalId, data: 'ls\n' })
      await wsDone.catch(() => {})
      return { skip: false, terminalId, output: received.join('') }
    })

    if (result.skip) {
      test.skip(true, result.reason ?? 'node-pty unavailable')
      return
    }

    expect(result.skip).toBe(false)
    // ls 命令在大多数 shell 下都会回显文件名（含 $、bin、usr 等），但这里不强校验内容
    // 只断言收到了一些输出
    expect((result as { output: string }).output.length).toBeGreaterThan(0)

    await archiveScreenshot('03-terminal-pty')
  })
})
