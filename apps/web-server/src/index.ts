/**
 * web-server 入口。
 *
 * 启动：
 *   bun run apps/web-server/src/index.ts
 *
 * 环境变量：
 *   PROMA_WEB_HOST          默认 127.0.0.1
 *   PROMA_WEB_PORT          默认 5174
 *   PROMA_WEB_TOKEN         远程访问所需 token；不设=仅本机
 *   PROMA_WEB_REQUIRE_TOKEN 设 0 可关闭强制 token
 */

import { loadConfig } from './config'
import { createApp } from './app'
import { createPtyWebSocketHandlers } from './pty-handler'
import { startParentBridge, isParentBridgeEnabled } from './parent-bridge'

// 嵌入模式：尽早启动父进程桥（stdin 行流），让 RPC / 事件桥接可用
startParentBridge()

const config = loadConfig()
const app = createApp(config)
const ptyHandlers = createPtyWebSocketHandlers()

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url)
    // 把 /api/pty/{terminalId} 升级为 WebSocket
    const match = url.pathname.match(/^\/api\/pty\/([^/]+)$/)
    if (match) {
      const terminalId = decodeURIComponent(match[1]!)
      if (config.token) {
        const headerToken = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
        const queryToken = url.searchParams.get('token')
        const provided = headerToken ?? queryToken
        if (!provided || !constantTimeEqual(provided, config.token)) {
          return new Response(JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      const ok = (srv as unknown as { upgrade: (req: Request, opts: { data: unknown }) => boolean }).upgrade(req, {
        data: { __terminalId: terminalId },
      })
      if (ok) return undefined
      return new Response('Upgrade failed', { status: 500 })
    }
    return app.fetch(req)
  },
  websocket: ptyHandlers,
})

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// eslint-disable-next-line no-console
console.log(`[proma/web-server] listening on http://${server.hostname}:${server.port}`)
if (isParentBridgeEnabled()) {
  // eslint-disable-next-line no-console
  console.log('[proma/web-server] 父进程桥已启用（Agent/Chat 运行时委托桌面端执行）')
}
if (!config.token) {
  // eslint-disable-next-line no-console
  console.log('[proma/web-server] 无 token 配置，仅允许 loopback 访问')
}
else {
  // eslint-disable-next-line no-console
  console.log('[proma/web-server] 已启用 token 鉴权')
}

export { app }