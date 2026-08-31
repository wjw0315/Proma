/**
 * 用例 2：浏览器内 chat:send-message → SSE delta chunk
 *
 * 路径：
 *   1. 浏览器加载首页
 *   2. 通过 window.electronAPI 调 chat:send-message
 *   3. 打开 EventSource 订阅 chat:stream:{sessionId}
 *   4. 断言收到 SSE delta chunk 且 content 以 'echo:' 开头
 *   5. 断言收到 done chunk
 *   6. 截图归档
 *
 * 不渲染真实 UI（web-server 的 chat IPC 走 stub echo，不接 AI）。
 */

import { test, expect } from '../fixtures/test-base'

test.describe('E2E 2: chat 消息 → SSE 流式', () => {
  test('浏览器内 chat:send-message 触发 SSE delta + done', async ({ page, archiveScreenshot }) => {
    await page.goto('/')

    // main.tsx 加载后 web-shim 自动装好 window.electronAPI
    await page.waitForFunction(
      () => Boolean((window as unknown as { electronAPI?: unknown }).electronAPI),
      null,
      { timeout: 15_000 },
    )

    const sessionId = `e2e-session-${Date.now()}`

    // 一次性跑：发消息 + 订阅 SSE 等两个事件
    const result = await page.evaluate(async ({ sid }: { sid: string }) => {
      const api = (window as unknown as { electronAPI: { sendMessage?: (a: unknown) => Promise<unknown> } }).electronAPI
      if (typeof api.sendMessage !== 'function') {
        return { error: 'electronAPI.sendMessage 不存在；web-shim 未映射' as string }
      }

      // 1) EventSource 订阅 SSE
      const events: { kind: string; content?: string }[] = []
      const url = `/api/events?channel=${encodeURIComponent(`chat:stream:${sid}`)}`
      const es = new EventSource(url)
      // 等 SSE 订阅 ready
      const subscribed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE 等待 ready 超时')), 10_000)
        es.addEventListener('message', (ev) => {
          try {
            const parsed = JSON.parse((ev as MessageEvent).data) as { channel: string; data: { kind?: string; subscribed?: boolean; content?: string } }
            events.push((parsed.data ?? {}) as { kind: string; content?: string })
            if ((parsed.data?.kind === 'done') || (parsed.data?.subscribed === true && events.length >= 1)) {
              clearTimeout(timer)
              resolve()
            }
          }
          catch { /* ignore parse error */ }
        })
        es.onerror = () => {
          clearTimeout(timer)
          reject(new Error('SSE 连接错误'))
        }
      })
      await subscribed
      // 重置 timer：等 done
      const donePromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE 等待 done 超时')), 10_000)
        const handler = (ev: MessageEvent) => {
          try {
            const parsed = JSON.parse(ev.data) as { data: { kind?: string } }
            if (parsed.data?.kind === 'done') {
              clearTimeout(timer)
              es.removeEventListener('message', handler)
              resolve()
            }
          }
          catch { /* ignore */ }
        }
        es.addEventListener('message', handler)
      })

      // 2) 触发 chat:send-message
      await api.sendMessage({ sessionId: sid, content: 'hello e2e chat' })

      // 3) 等 done 事件
      await donePromise
      es.close()
      return { events }
    }, { sid: sessionId })

    expect(result.error).toBeUndefined()
    const events = (result as { events: { kind: string; content?: string }[] }).events

    const delta = events.find((e) => e.kind === 'delta')
    expect(delta, '应收到至少一个 delta chunk').toBeDefined()
    expect(delta?.content?.startsWith('echo:')).toBe(true)

    const done = events.find((e) => e.kind === 'done')
    expect(done, '应收到 done 收尾').toBeDefined()

    await archiveScreenshot('02-chat-sse')
  })
})
