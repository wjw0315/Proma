/**
 * Hono 应用。
 *
 * 路由：
 *   GET  /health        存活检查
 *   POST /api/ipc       单次 request/response
 *   GET  /api/events    SSE 订阅
 *   WS   /api/pty/:id   终端双向流（Step 3 接入）
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAuthMiddleware } from './auth'
import { loadConfig, type WebServerConfig } from './config'
import { webEventBus } from './event-bus'
import { dispatch, isRegistered } from './ipc-router'
import { newTraceId, type WebServerContext } from './context'

export function createApp(config: WebServerConfig): Hono {
  const app = new Hono()

  app.use('*', createAuthMiddleware(config))

  app.get('/health', (c) => c.json({ ok: true, kind: 'web', ts: Date.now() }))

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

  return app
}

export { loadConfig }