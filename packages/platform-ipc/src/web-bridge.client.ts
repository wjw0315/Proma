/**
 * Web 形态的 PlatformAPI 实现。
 *
 * 协议：
 * - request: HTTP POST /api/ipc -> { channel, args }，响应 { ok: true, data } 或 { ok: false, error }
 * - subscribe: SSE GET /api/events?channel=xxx，事件帧 { channel, data }
 * - openStream: WebSocket /api/pty/{terminalId}，双向 JSON 帧
 *
 * 鉴权：从 URL hash 或 localStorage 读取 token，加到 Authorization / query 里
 */

import {
  PlatformNetworkError,
  PlatformTimeoutError,
  PlatformUnsupportedError,
} from './errors'
import type {
  PlatformAPI,
  PlatformCapabilities,
  PlatformBidirectionalChannel,
  PlatformBidirectionalFactory,
  PlatformRequest,
  PlatformSubscribe,
} from './types'

const WEB_CAPABILITIES: PlatformCapabilities = {
  hasTray: false,
  hasNativeMenu: false,
  hasEventKit: false,
  hasAutoUpdate: false,
  hasShellOpen: false,
  hasFileDialog: false,
  hasPty: true,
}

export interface WebBridgeOptions {
  /** web-server base URL，默认同源 */
  baseUrl?: string
  /** 鉴权 token；从 PROMA_WEB_TOKEN / 用户输入获取 */
  token?: string
  /** 默认 30s */
  timeoutMs?: number
  /** SSE 心跳超时；超过则重连，默认 60s */
  sseIdleMs?: number
}

export function createWebPlatform(options: WebBridgeOptions = {}): PlatformAPI {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
  const token = options.token
  const timeoutMs = options.timeoutMs ?? 30_000

  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}

  const request: PlatformRequest = async <TResponse>(channel: string, args?: unknown): Promise<TResponse> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/api/ipc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ channel, args }),
        signal: controller.signal,
      })
      // 先尝试读 body——web-server 即使在 4xx/5xx 也会返回结构化 JSON { ok: false, error: { code, message } }
      // 这样能识别 PLATFORM_UNSUPPORTED（避免把它误判为网络错误）
      // 读失败（body 不是 JSON）才回退到 raw text
      const body = (await res.json().catch(() => null)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { message: string; code?: string } }
        | null
      if (body === null) {
        throw new PlatformNetworkError(channel, res.status, await safeText(res))
      }
      if (!body.ok) {
        if (body.error.code === 'PLATFORM_UNSUPPORTED') {
          throw new PlatformUnsupportedError(body.error.message)
        }
        throw new PlatformNetworkError(channel, res.status, body.error.message)
      }
      return body.data as TResponse
    } catch (error) {
      if (error instanceof PlatformNetworkError) throw error
      if (error instanceof PlatformUnsupportedError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new PlatformTimeoutError(channel, timeoutMs)
      }
      throw new PlatformNetworkError(channel, undefined, (error as Error).message)
    } finally {
      clearTimeout(timer)
    }
  }

  const subscribe: PlatformSubscribe = <TEvent>(channel: string, handler: (event: TEvent) => void) => {
    const url = new URL(`${baseUrl}/api/events`, baseUrl || window.location.origin)
    url.searchParams.set('channel', channel)
    if (token) url.searchParams.set('token', token)
    const es = new EventSource(url.toString())

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as { channel: string; data: unknown }
        // 单向推送，TEvent 由调用方按 channel 收窄；这里按 unknown 转发
        (handler as (e: unknown) => void)(frame.data)
      } catch {
        // 忽略解析失败的单帧
      }
    }
    es.addEventListener('message', onMessage)

    return () => {
      es.removeEventListener('message', onMessage)
      es.close()
    }
  }

  const openStream: PlatformBidirectionalFactory = (channel, opts) => {
    if (!opts?.terminalId) {
      throw new Error('openStream requires terminalId for Web terminal channels')
    }
    const wsUrl = new URL(`${baseUrl}/api/pty/${encodeURIComponent(opts.terminalId)}`,
      baseUrl ? `${baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`}` : window.location.origin)
    wsUrl.protocol = wsUrl.protocol.replace('http', 'ws')
    if (token) wsUrl.searchParams.set('token', token)

    let socket: WebSocket | null = new WebSocket(wsUrl.toString())
    let readyState: PlatformBidirectionalChannel['readyState'] = 'connecting'
    const handlers = new Set<(frame: unknown) => void>()

    socket.addEventListener('open', () => {
      readyState = 'open'
    })
    socket.addEventListener('close', () => {
      readyState = 'closed'
    })
    socket.addEventListener('error', () => {
      readyState = 'closed'
    })
    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(event.data as string) as unknown
        handlers.forEach((h) => h(frame))
      } catch {
        // 忽略坏帧
      }
    })

    const channel_: PlatformBidirectionalChannel = {
      send(frame) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error('WebSocket 尚未打开')
        }
        socket.send(JSON.stringify(frame))
      },
      onMessage(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      close() {
        readyState = 'closing'
        socket?.close()
        socket = null
      },
      get readyState() {
        return readyState
      },
    }
    // suppress unused; channel is the public surface
    void channel
    return channel_
  }

  return {
    kind: 'web',
    capabilities: WEB_CAPABILITIES,
    request,
    subscribe,
    openStream,
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return res.statusText
  }
}

// keep types referenced
export type { PlatformBidirectionalChannel }