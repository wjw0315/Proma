import { describe, expect, test } from 'bun:test'
import {
  PlatformNetworkError,
  PlatformUnsupportedError,
  PlatformTimeoutError,
} from './errors'

describe('platform-ipc errors', () => {
  test('PlatformUnsupportedError 携带 capability', () => {
    const err = new PlatformUnsupportedError('shell:open-external')
    expect(err.name).toBe('PlatformUnsupportedError')
    expect(err.code).toBe('PLATFORM_UNSUPPORTED')
    expect(err.capability).toBe('shell:open-external')
    expect(err.message).toContain('shell:open-external')
  })

  test('PlatformTimeoutError 携带 channel', () => {
    const err = new PlatformTimeoutError('chat:send', 30_000)
    expect(err.code).toBe('PLATFORM_TIMEOUT')
    expect(err.channel).toBe('chat:send')
    expect(err.message).toContain('30')
  })

  test('PlatformNetworkError 携带 status', () => {
    const err = new PlatformNetworkError('foo:bar', 502, 'Bad Gateway')
    expect(err.code).toBe('PLATFORM_NETWORK')
    expect(err.channel).toBe('foo:bar')
    expect(err.status).toBe(502)
    expect(err.message).toContain('502')
  })

  test('PlatformNetworkError 无 status 时', () => {
    const err = new PlatformNetworkError('foo:bar', undefined, '连接被重置')
    expect(err.status).toBeUndefined()
    expect(err.message).not.toContain('undefined')
  })
})

import { createWebPlatform } from './web-bridge.client'

describe('platform-ipc web-bridge 5xx + JSON body 识别', () => {
  test('501 + JSON body 带 PLATFORM_UNSUPPORTED code：识别为 PlatformUnsupportedError', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { message: '当前形态不支持能力：window:minimize', code: 'PLATFORM_UNSUPPORTED' },
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const platform = createWebPlatform({ baseUrl: 'http://stub' })
      await expect(platform.request('window:minimize')).rejects.toBeInstanceOf(PlatformUnsupportedError)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('500 + JSON body 带其他 code：识别为 PlatformNetworkError', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { message: 'internal', code: 'INTERNAL' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const platform = createWebPlatform({ baseUrl: 'http://stub' })
      await expect(platform.request('foo:bar')).rejects.toBeInstanceOf(PlatformNetworkError)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  test('非 JSON 响应（如纯文本 502）：回退到 PlatformNetworkError 携带 text', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch
    try {
      const platform = createWebPlatform({ baseUrl: 'http://stub' })
      await expect(platform.request('foo:bar')).rejects.toBeInstanceOf(PlatformNetworkError)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})