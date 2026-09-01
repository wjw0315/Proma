/**
 * Hono 应用。
 *
 * 路由：
 *   GET  /health        存活检查
 *   POST /api/ipc       单次 request/response
 *   GET  /api/events    SSE 订阅
 *   WS   /api/pty/:id   终端双向流（Step 3 接入）
 *   GET  /*             静态资源（PROMA_WEB_STATIC_DIR 配置时启用，SPA fallback 到 index.html）
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAuthMiddleware } from './auth'
import { loadConfig, type WebServerConfig } from './config'
import { webEventBus } from './event-bus'
import { dispatch, isRegistered } from './ipc-router'
import { newTraceId, type WebServerContext } from './context'

/** 静态托管的根目录；未配置（或目录不存在）时 web-server 仅提供 API。 */
const STATIC_ROOT = process.env.PROMA_WEB_STATIC_DIR ?? ''

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/**
 * 解析静态文件请求（含路径穿越防护与 SPA fallback）。
 * 返回 null 表示静态托管未启用或文件不存在（走 Hono 默认 404）。
 */
async function serveStaticFile(pathname: string): Promise<Response | null> {
  if (!STATIC_ROOT) return null
  const decoded = decodeURIComponent(pathname)
  const relative = decoded.replace(/^\/+/, '')
  if (relative.includes('..') || relative.includes('\\')) return null
  let candidate = `${STATIC_ROOT.replace(/\/+$/, '')}/${relative || 'index.html'}`
  let file = Bun.file(candidate)
  if (!(await file.exists())) {
    // SPA fallback：非 API 路径且无扩展名的，回 index.html（renderer 用 hash/相对路由）
    const hasExt = /\.[a-zA-Z0-9]+$/.test(relative)
    if (hasExt) return null
    candidate = `${STATIC_ROOT.replace(/\/+$/, '')}/index.html`
    file = Bun.file(candidate)
    if (!(await file.exists())) return null
  }
  const ext = candidate.slice(candidate.lastIndexOf('.'))
  return new Response(file, {
    headers: {
      'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
      // 带 hash 的 Vite 产物可长缓存；index.html 不缓存避免发版后白屏
      'Cache-Control': candidate.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    },
  })
}

export function createApp(config: WebServerConfig): Hono {
  const app = new Hono()

  app.use('*', createAuthMiddleware(config))

  app.get('/health', (c) => c.json({ ok: true, kind: 'web', ts: Date.now() }))

  // ===== API 路由必须先于静态 catch-all 注册 =====
  // （Hono 按注册顺序匹配：app.get('*') 会吞掉后注册的 GET 路由，
  //   曾导致 /api/events 被 SPA fallback 的 index.html 覆盖，SSE 全部失效）

  app.post('/api/ipc', async (c) => {
    const body = await c.req.json().catch(() => null) as
      | { channel?: string; args?: unknown }
      | null
    if (!body?.channel) {
      return c.json({ ok: false, error: { message: 'channel 必填', code: 'BAD_REQUEST' } }, 400)
    }
    const traceId = newTraceId()
    const ctx: WebServerContext = {
      traceId,
      userDataDir: process.env.PROMA_USER_DATA_DIR ?? './.proma-userdata',
      eventBus: webEventBus,
      log(level, message, meta) {
        // eslint-disable-next-line no-console
        console[level](`[${traceId}] ${message}`, meta ?? {})
      },
    }
    try {
      const data = await dispatch(body.channel, body.args, ctx)
      return c.json({ ok: true, data })
    } catch (error) {
      const err = error as Error & { code?: string; capability?: string }
      if (err.name === 'PlatformUnsupportedError') {
        return c.json({
          ok: false,
          error: { message: err.message, code: 'PLATFORM_UNSUPPORTED' },
        }, 501)
      }
      ctx.log('error', `IPC ${body.channel} 失败`, { message: err.message })
      return c.json({
        ok: false,
        error: { message: err.message, code: err.code ?? 'INTERNAL' },
      }, 500)
    }
  })

  app.get('/api/events', (c) => {
    const channel = c.req.query('channel')
    if (!channel) {
      return c.json({ ok: false, error: { message: 'channel 必填', code: 'BAD_REQUEST' } }, 400)
    }
    if (!isRegistered(channel) && !channel.startsWith('agent:') && !channel.startsWith('chat:')) {
      // 不做严格拦截：未知 channel 也允许订阅，发布时直接被丢弃
    }
    const idleMs = config.sseIdleMs
    return streamSSE(c, async (stream) => {
      const send = async (event: { channel: string; data: unknown; ts: number }) => {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify(event),
        })
      }
      const unsub = webEventBus.subscribe(channel, (event) => {
        void send(event)
      })
      // 心跳
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {})
      }, Math.max(15_000, Math.floor(idleMs / 4)))
      try {
        // 初次订阅立刻推一条 ready
        await send({ channel, data: { subscribed: true }, ts: Date.now() })
        // 保持连接直到客户端断开
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve())
        })
      } finally {
        clearInterval(heartbeat)
        unsub()
      }
    })
  })

  // ===== 静态托管（鉴权之后；所有 API 路由之后注册，避免覆盖 /api/*） =====
  app.get('*', async (c) => {
    const res = await serveStaticFile(c.req.path)
    return res ?? c.text('Not Found', 404)
  })

  return app
}

export { loadConfig }