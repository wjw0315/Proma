/**
 * Token 鉴权：常量时间比较。
 *
 * 来源优先级：
 * 1. Authorization: Bearer xxx
 * 2. 查询参数 ?token=xxx
 * 3. SSE / WS 在 query 里传 token
 *
 * 未配置 token 时，所有请求视为通过（仅 127.0.0.1 默认绑定时生效）。
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { WebServerConfig } from './config'

export function createAuthMiddleware(config: WebServerConfig): MiddlewareHandler {
  // 服务启动时随机生成一个内部 token，避免无 token 配置下也能被命中。
  const expected = config.token

  return async (c: Context, next) => {
    if (!expected) {
      // 本机/无 token 模式：只允许 loopback 连接
      const remote = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        ?? c.req.raw.headers.get('x-real-ip')
      if (remote && remote !== '127.0.0.1' && remote !== '::1' && !remote.startsWith('127.')) {
        return c.json({ ok: false, error: { message: '无 token 配置时仅允许本机访问', code: 'AUTH_REQUIRED' } }, 401)
      }
      return next()
    }

    const headerToken = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const queryToken = c.req.query('token')
    const provided = headerToken ?? queryToken
    if (!provided || !constantTimeEqual(provided, expected)) {
      return c.json({ ok: false, error: { message: '鉴权失败', code: 'AUTH_REQUIRED' } }, 401)
    }
    return next()
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}