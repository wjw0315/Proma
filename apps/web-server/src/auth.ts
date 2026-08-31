/**
 * Token 鉴权：常量时间比较。
 *
 * 来源优先级：
 * 1. Authorization: Bearer xxx
 * 2. 查询参数 ?token=xxx
 * 3. Cookie proma_web_token（静态 UI 场景：浏览器打开 /?token=xxx 后，
 *    后续 /assets/* 请求无法携带 query token，靠 cookie 续推鉴权）
 * 4. SSE / WS 在 query 里传 token
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
    const cookieToken = getCookie(c.req.raw.headers.get('cookie'), 'proma_web_token')
    const provided = headerToken ?? queryToken ?? cookieToken
    if (!provided || !constantTimeEqual(provided, expected)) {
      return c.json({ ok: false, error: { message: '鉴权失败', code: 'AUTH_REQUIRED' } }, 401)
    }
    // 静态 UI：首次用 ?token= 打开后种 cookie，后续资源 / API 请求凭 cookie 访问。
    // 必须往 await next() 之后的最终响应上写（next() 会覆盖 c.res）。
    const shouldSetCookie = Boolean(queryToken) && !cookieToken
    await next()
    if (shouldSetCookie && queryToken) {
      c.res.headers.set(
        'set-cookie',
        `proma_web_token=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      )
    }
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

/** 从 Cookie 头中解析指定 key（不引入依赖，仅处理简单的 a=b; c=d 形式）。 */
function getCookie(cookieHeader: string | null, key: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === key) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}