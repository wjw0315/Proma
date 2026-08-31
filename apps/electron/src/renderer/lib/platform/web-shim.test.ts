/**
 * web-shim 单测。
 *
 * 测试目标：
 * 1. pickPlaceholder 按 method 名正确选择占位
 * 2. safeRequest 在 PlatformUnsupportedError 时降级；其他错误继续抛出
 * 3. WEB_METHODS_GENERATED 包含关键 method（来自 codemod 自动生成）
 * 4. WEB_METHODS_OVERRIDES 手写表覆盖 sendSync / 非 IPC 方法
 * 5. installWebElectronProxy 在 mock window + mock platform 下正确代理
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import type { PlatformAPI } from '@proma/platform-ipc'

import { WEB_METHODS_GENERATED } from './web-shim.generated'
import { installWebElectronProxy, safeRequest, webPickPlaceholder } from './web-shim'

// ---- 1. pickPlaceholder 启发式 ----
describe('webPickPlaceholder', () => {
  test('列表/搜索/获取远端数据类返回空数组', () => {
    expect(webPickPlaceholder('listConversations')).toEqual([])
    expect(webPickPlaceholder('searchAgentSessionMessages')).toEqual([])
    expect(webPickPlaceholder('fetchModels')).toEqual([])
  })

  test('get* / load* / take* 返回 null（单值获取）', () => {
    expect(webPickPlaceholder('getSettings')).toBeNull()
    expect(webPickPlaceholder('loadScratchPad')).toBeNull()
    expect(webPickPlaceholder('takeWorktreeSnapshot')).toBeNull()
  })

  test('is/has/can/should/check 返回 false', () => {
    expect(webPickPlaceholder('isMaximized')).toBe(false)
    expect(webPickPlaceholder('hasMcpServer')).toBe(false)
    expect(webPickPlaceholder('checkEnvironment')).toBe(false)
  })

  test('写/改/删/启停返回 false', () => {
    expect(webPickPlaceholder('saveScratchPad')).toBe(false)
    expect(webPickPlaceholder('updateChannel')).toBe(false)
    expect(webPickPlaceholder('deleteConversation')).toBe(false)
    expect(webPickPlaceholder('startAgent')).toBe(false)
    expect(webPickPlaceholder('stopAgent')).toBe(false)
    expect(webPickPlaceholder('togglePinConversation')).toBe(false)
  })

  test('未知前缀默认 null（不抛）', () => {
    expect(webPickPlaceholder('someUnknownMethod')).toBeNull()
    expect(webPickPlaceholder('xyz')).toBeNull()
  })
})

// ---- 2. safeRequest 错误降级 ----
type MockRequest = (channel: string, args?: unknown) => Promise<unknown>

function makeMockPlatform(impl: MockRequest): PlatformAPI {
  return {
    kind: 'web',
    capabilities: {
      hasTray: false,
      hasNativeMenu: false,
      hasEventKit: false,
      hasAutoUpdate: false,
      hasShellOpen: false,
      hasFileDialog: false,
      hasPty: false,
    },
    // wrap 成 PlatformAPI.request 泛型形式
    request: impl as PlatformAPI['request'],
    subscribe: () => () => {},
    openStream: () => {
      throw new Error('not implemented in mock')
    },
  }
}

describe('safeRequest', () => {
  test('正常响应原样返回', async () => {
    const platform = makeMockPlatform(async (channel) => {
      expect(channel).toBe('test:echo')
      return { ok: true }
    })
    const result = await safeRequest(platform, 'test:echo', { x: 1 }, null)
    expect(result).toEqual({ ok: true })
  })

  test('PlatformUnsupportedError 时降级到 placeholder', async () => {
    const platform = makeMockPlatform(async (channel) => {
      throw new PlatformUnsupportedError(channel, 'not registered')
    })
    const result = await safeRequest(platform, 'unregistered:foo', { x: 1 }, [])
    expect(result).toEqual([])
  })

  test('非 PlatformUnsupportedError 错误继续抛出', async () => {
    const platform = makeMockPlatform(async () => {
      throw new Error('网络断了')
    })
    await expect(
      safeRequest(platform, 'test:foo', null, []),
    ).rejects.toThrow('网络断了')
  })
})

// ---- 3. WEB_METHODS_GENERATED 完整性（来自 codemod） ----
describe('WEB_METHODS_GENERATED 来自 codemod 的关键 method', () => {
  test('覆盖 4xx+ 个 method（含嵌套命名空间）', () => {
    expect(Object.keys(WEB_METHODS_GENERATED).length).toBeGreaterThanOrEqual(400)
  })

  test('getRuntimeStatus → runtime:get-status', () => {
    expect(WEB_METHODS_GENERATED.getRuntimeStatus).toEqual({
      kind: 'invoke',
      channel: 'runtime:get-status',
      arity: 0,
    })
  })

  test('sendMessage → chat:send-message (invoke)', () => {
    expect(WEB_METHODS_GENERATED.sendMessage?.kind).toBe('invoke')
  })

  test('onAgentStreamEvent → agent:stream-event (on)', () => {
    expect(WEB_METHODS_GENERATED.onAgentStreamEvent?.kind).toBe('on')
  })

  test('acknowledgeTerminalOutput → terminal:ack-output (send)', () => {
    expect(WEB_METHODS_GENERATED.acknowledgeTerminalOutput).toEqual({
      kind: 'send',
      channel: 'terminal:ack-output',
      arity: 1,
    })
  })

  test('嵌套命名空间 method 用 `parent.child` 作为 key', () => {
    expect(WEB_METHODS_GENERATED['updater.checkForUpdates']).toEqual({
      kind: 'invoke',
      channel: 'updater:check',
      arity: 0,
    })
    expect(WEB_METHODS_GENERATED['agentIsland.markSessionViewed']).toEqual({
      kind: 'invoke',
      channel: 'agent-island:mark-session-viewed',
      arity: 1,
    })
  })

  test('所有 channel 字符串都是 `domain:rest` 形式（可多段）', () => {
    // 允许 `domain:verb-noun` 或 `domain:noun:verb`（如 agent:stream:complete）
    const badKey = Object.entries(WEB_METHODS_GENERATED).find(
      ([, spec]) => !/^[a-z][a-z0-9-]*:[a-z0-9:-]+$/i.test(spec.channel),
    )
    expect(badKey).toBeUndefined()
  })

  test('无重复 key', () => {
    const keys = Object.keys(WEB_METHODS_GENERATED)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ---- 4. installWebElectronProxy DOM 集成 ----
type GlobalWithMode = { window?: unknown; __PROMA_WEB_MODE__?: boolean }

describe('installWebElectronProxy 端到端', () => {
  let originalWindow: unknown
  let originalMode: boolean

  beforeEach(() => {
    const g = globalThis as unknown as GlobalWithMode
    originalWindow = g.window
    originalMode = g.__PROMA_WEB_MODE__ ?? false
  })

  afterEach(() => {
    const g = globalThis as unknown as GlobalWithMode
    if (originalWindow === undefined) {
      delete g.window
    } else {
      g.window = originalWindow
    }
    g.__PROMA_WEB_MODE__ = originalMode
  })

  function setupDom(preFill?: Record<string, unknown>) {
    // electronAPI 可选预置：用于测试"已存在不覆盖"场景
    const win: { electronAPI?: unknown } = {}
    if (preFill) win.electronAPI = preFill
    const g = globalThis as unknown as GlobalWithMode
    g.window = win
    g.__PROMA_WEB_MODE__ = true
    return { win }
  }

  /**
   * 把 win.electronAPI 断言成"任意方法名都返回一个函数"的 api，
   * 避免 strictNullCheck 与 noUncheckedIndexedAccess 烦扰。
   * 返回 any 是有意的：测试只关心行为不关心类型。
   * 逻辑：函数原样返回；其他值原样透传（嵌套对象如 `updater` 保持对象形态）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function asApi(win: { electronAPI?: unknown }): any {
    const target = (win.electronAPI ?? {}) as object
    return new Proxy(target, {
      get: (t, prop) => {
        if (typeof prop === 'symbol') return (t as Record<symbol, unknown>)[prop]
        return (t as Record<string, unknown>)[prop as string]
      },
    })
  }

  test('在非 Web 形态下不挂代理', () => {
    const pre = {} as Record<string, unknown>
    const { win } = setupDom(pre)
    ;(globalThis as unknown as GlobalWithMode).__PROMA_WEB_MODE__ = false
    installWebElectronProxy()
    expect(win.electronAPI).toBe(pre)
  })

  test('已存在 electronAPI 时不覆盖（Electron 形态）', () => {
    const pre = {} as Record<string, unknown>
    const { win } = setupDom(pre)
    const sentinel = 'electron-real'
    pre.getRuntimeStatus = sentinel
    // __PROMA_WEB_MODE__=true 但 electronAPI 已存在
    installWebElectronProxy()
    expect((win.electronAPI as Record<string, unknown>).getRuntimeStatus).toBe(sentinel)
  })

  test('挂上后 invoke method 调用 platform.request 并透传 args（多参压成数组）', async () => {
    const { win } = setupDom()
    const requestMock = mock(async (channel: string, args?: unknown) => {
      if (channel === 'channel:list') {
        // preload 里 ipcRenderer.invoke(CH, a, b, c) 是多位置参数；
        // web-shim 把 rest 参数压成数组传给 platform.request，
        // 由 web-server handler 自行 spread（类似 main 进程多参 handler）。
        expect(args).toEqual([{ filter: 'active' }])
        return [{ id: 'ch1' }]
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
    const platform = makeMockPlatform(requestMock)
    installWebElectronProxy(platform)

    const api = asApi(win)
    const result = await api.listChannels({ filter: 'active' })
    expect(requestMock).toHaveBeenCalled()
    expect(result).toEqual([{ id: 'ch1' }])
  })

  test('invoke method 在 PlatformUnsupportedError 时返回 list→[] 占位', async () => {
    const { win } = setupDom()
    const platform = makeMockPlatform(async (channel) => {
      throw new PlatformUnsupportedError(channel, 'not registered')
    })
    installWebElectronProxy(platform)

    const api = asApi(win)
    const result = await api.listConversations()
    expect(result).toEqual([])
  })

  test('invoke method 在 PlatformUnsupportedError 时返回 get*→null 占位', async () => {
    const { win } = setupDom()
    const platform = makeMockPlatform(async (channel) => {
      throw new PlatformUnsupportedError(channel, 'not registered')
    })
    installWebElectronProxy(platform)

    const api = asApi(win)
    const result = await api.getSettings()
    expect(result).toBeNull()
  })

  test('on* 订阅返回 no-op unsubscribe 函数', () => {
    const { win } = setupDom()
    const platform = makeMockPlatform(async () => null)
    installWebElectronProxy(platform)

    const api = asApi(win)
    const unsubscribe = api.onAgentStreamEvent(() => {}) as () => void
    expect(typeof unsubscribe).toBe('function')
    // 调用 unsubscribe 不抛
    expect(() => unsubscribe()).not.toThrow()
  })

  test('命名空间访问返回安全 stub（任何调用都返回 undefined）', async () => {
    const { win } = setupDom()
    const platform = makeMockPlatform(async () => null)
    installWebElectronProxy(platform)

    const api = asApi(win)
    const updater = api.updater
    expect(typeof updater).toBe('object')
    const result = await updater.checkForUpdates()
    expect(result).toBeUndefined()
  })

  test('手写表（sendSync / getPathForFile / onWindowResize）走 override 不走 platform', async () => {
    const { win } = setupDom()
    // 故意让 platform 抛错；如果走 platform 路径，测试会失败
    const platform = makeMockPlatform(async () => {
      throw new Error('should not be called for override methods')
    })
    installWebElectronProxy(platform)

    const api = asApi(win)
    expect(api.updateSettingsSync({})).toBe(false)
    expect(api.saveScratchPadSync('content')).toBe(false)
    expect(api.getPathForFile({} as File)).toBe('')
    expect(api.setDockBadgeCount(5)).resolves.toBeUndefined()
    const unsub = api.onWindowResize(() => {}) as () => void
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  test('未映射 method 抛 `未在 Web 形态实现` 错误', async () => {
    const { win } = setupDom()
    const platform = makeMockPlatform(async () => null)
    installWebElectronProxy(platform)

    const api = asApi(win)
    await expect(api.someTrulyUnknownMethod()).rejects.toThrow(
      /未在 Web 形态实现/,
    )
  })
})
