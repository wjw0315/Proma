/**
 * Web 形态下，把 window.electronAPI.* 的方法代理到 web-server。
 *
 * 工作原理：
 * - preload 在 Web 形态下没有运行，window.electronAPI 不存在
 * - web-server 与 Vite dev 通过反代共享同源，因此 fetch / EventSource / WebSocket 都直接走
 * - 本模块在 main.tsx 最早期执行，构造一个 __electronAPIWebProxy 对象并赋给 window.electronAPI
 *
 * 数据源：
 * - WEB_METHODS_AUTOGEN（从 web-shim.generated.ts 导入）：通过 codemod 从 preload AST
 *   自动提取，覆盖 ~424 个走 ipcRenderer.invoke/send/on 的 method
 * - WEB_METHODS_OVERRIDES（本文件手写）：覆盖 codemod 抓不到 / 需要特殊处理的少数 method
 *   （sendSync、webUtils、window 事件、命名空间 stub 等）
 * - 命名空间 stub：updater / agentIsland / feishu / dingtalk 等嵌套对象在 Proxy.get 里 stub
 *
 * 错误降级：
 * - 大量 channel 在 web-server 路由表还没注册，访问会抛 PlatformUnsupportedError
 * - web-shim 在顶层 try/catch 降级为合理空值（list→[]、get→null、is/has→false、save→false），
 *   UI 调用不崩；UI 层可以用 isPlatformUnsupportedError(err) 检测原始错误做空状态
 */

import { createWebPlatform } from '@proma/platform-ipc/web'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import type { PlatformAPI } from '@proma/platform-ipc'

import { WEB_METHODS_GENERATED } from './web-shim.generated'
import type {
  GeneratedWebMethodSpec,
  WebMethodKind,
  WebPlaceholder,
} from './web-shim.types'

declare const __PROMA_WEB_MODE__: boolean

const WEB_PLATFORM: PlatformAPI = createWebPlatform({
  baseUrl: '', // 同源；通过 Vite 反代到 web-server
})

/**
 * 手写表，覆盖 codemod 抓不到 / 需要特殊处理的少数 method。
 * 这些 method 不在自动生成的 WEB_METHODS_GENERATED 中。
 *
 * 优先级：在 Proxy.get 里先查这张表，再查生成表。
 */
type WebMethod = (...args: unknown[]) => unknown

/**
 * 不做静默降级的 method：高价值「发送」类动作。
 *
 * safeRequest 的占位降级会把 PlatformUnsupportedError 伪装成成功（resolve null/false）。
 * 对发送消息这类动作，这等于「消息凭空消失 + Agent Running 永久挂起」，用户完全无感知。
 * 这些 method 让原始错误穿透到调用方，由 UI 的 .catch 展示错误并复位运行状态。
 *
 * 注意：新增发送类 method（走 invoke/send 且失败必须可见）时应同步维护此表。
 */
const NO_DEGRADE_METHODS = new Set([
  'sendAgentMessage',            // agent:send-message（Agent 主发送路径）
  'submitOrEnqueueAgentMessage', // agent:submit-or-enqueue-message（队列立即发送/注入）
  'queueAgentMessage',           // agent:queue-message（排队发送）
  'sendMessage',                 // chat:send-message（防御：当前已实现，同类风险）
])
const WEB_METHODS_OVERRIDES: Record<string, WebMethod> = {
  // ===== ipcRenderer.sendSync：Web 无同步 IPC 语义，统一返回 false =====
  updateSettingsSync: () => false,
  saveScratchPadSync: () => false,

  // ===== 非 IPC 方法：web 形态下降级 =====
  // webUtils.getPathForFile 在 Web 形态没有等价物（无 File.path 概念），返回空字符串
  getPathForFile: () => '',
  // onWindowResize 在 preload 里用 window.addEventListener，Web 形态直接返回 no-op unsubscribe
  onWindowResize: () => () => {},

  // ===== 桌面专属：no-op 即可 =====
  setDockBadgeCount: async () => undefined,
}

/**
 * 占位返回启发式：按 method 名推断 Web 形态下降级值。
 * 用于在 web-server 路由表没注册时，调用不抛错。
 */
function pickPlaceholder(method: string): unknown {
  if (/^(list|search|fetch|query|get|take|load)/i.test(method)) {
    // 列表类方法 → 空数组；其余 get* 类 → null
    if (/^(list|search|fetch)/i.test(method)) return []
    return null
  }
  if (/^(is|has|can|should|check)/i.test(method)) return false
  if (/^(save|write|create|update|delete|remove|cancel|acknowledge|approve|reject|enable|disable|attach|detach|attachWorkspace|detachWorkspace|toggle|start|stop|run|copy|move|rename|mark|clear|reset|attachWorkspace|detachWorkspace)/i.test(method)) {
    return false
  }
  if (/^(get|load|fetch)/i.test(method)) return null
  return null
}

/**
 * 安全调用 web-server：捕获 PlatformUnsupportedError 并降级。
 * 其他错误（网络、超时）继续抛出 —— 那是真问题，需要 UI 处理。
 *
 * platform 参数可注入：renderer 运行时为 WEB_PLATFORM；测试中可传 mock。
 * @internal
 */
export async function safeRequest(
  platform: PlatformAPI,
  channel: string,
  args: unknown,
  placeholder: unknown,
): Promise<unknown> {
  try {
    return await platform.request(channel, args)
  } catch (err) {
    if (err instanceof PlatformUnsupportedError) return placeholder
    throw err
  }
}

/**
 * 把生成表里的 method 包装成实际函数（透传 args）。
 * 生成的 kind 决定调用形式：
 *   - invoke / send → safeRequest（捕获 PlatformUnsupportedError 降级）
 *   - on → WEB_PLATFORM.subscribe（事件源；走 SSE，web-server event-bus publish 即推送）
 */
function buildGeneratedMethod(method: string, spec: GeneratedWebMethodSpec, platform: PlatformAPI = WEB_PLATFORM): WebMethod {
  if (spec.kind === 'on') {
    return (handler: unknown) => {
      // 走 SSE：web-server 的 event-bus.publish(channel, payload) 会推到 EventSource；
      // web-bridge.client.ts 已把 JSON 帧的 data 字段透传给 handler。
      return platform.subscribe(spec.channel, handler as (event: unknown) => void)
    }
  }
  const placeholder = pickPlaceholder(method)
  // 把多个位置参数压成 args 数组传给 platform.request（preload 里 invoke(CH, a, b) 多参）。
  // 发送类 method（NO_DEGRADE_METHODS）不走 safeRequest：PlatformUnsupportedError
  // 必须穿透到 UI .catch，否则发送失败被伪装成成功，消息凭空消失且无任何提示。
  if (NO_DEGRADE_METHODS.has(method)) {
    return (...args: unknown[]) => platform.request(spec.channel, args)
  }
  return (...args: unknown[]) => safeRequest(platform, spec.channel, args, placeholder)
}

/**
 * 在 Web 形态下，用 Proxy 包裹一个空对象，把任意方法访问代理到 WEB_METHODS。
 * 桌面专属能力返回 undefined / 抛错。
 */
export function installWebElectronProxy(platform: PlatformAPI = WEB_PLATFORM): void {
  if (!__PROMA_WEB_MODE__) return
  if (typeof window === 'undefined') return
  if (window.electronAPI) return // Electron 形态下不覆盖

  // 预先生成 method 表（O(n)，n≈400；Proxy.get 是热路径，省去每次构造）
  const generatedMethods: Record<string, WebMethod> = {}
  for (const [method, spec] of Object.entries(WEB_METHODS_GENERATED)) {
    generatedMethods[method] = buildGeneratedMethod(method, spec, platform)
  }

  // updater 命名空间在 Web 形态下提供“足够真实”的 stub，避免 atoms/updater.ts
  // 在 useEffect 中调 updater.getStatus() 后 .then(setStatus) 拿到 undefined 报错。
  const updaterStub = {
    getStatus: async () => ({ status: 'idle' as const }),
    onStatusChanged: () => () => {},
    checkForUpdates: async () => undefined,
    quitAndInstall: async () => undefined,
    getVersion: async () => null,
    getChannel: async () => null,
  }

  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      // 1) 命名空间：返回安全 stub（任何访问都不抛）
      if (prop === 'updater') return updaterStub
      if (
        prop === 'feishu' ||
        prop === 'dingtalk' ||
        prop === 'agentIsland' ||
        prop === 'channel'
      ) {
        return new Proxy({}, {
          get: () => async () => undefined,
        })
      }
      // 2) 手写覆盖表
      const override = WEB_METHODS_OVERRIDES[prop]
      if (override) return override
      // 3) 自动生成表
      const generated = generatedMethods[prop]
      if (generated) return generated
      // 4) 未映射：保留旧行为（抛错，便于发现漏写）
      return async () => {
        throw new Error(`[web] electronAPI.${String(prop)} 未在 Web 形态实现`)
      }
    },
  })
  ;(window as unknown as { electronAPI: typeof proxy }).electronAPI = proxy
}

/**
 * 重新导出供 UI 层使用：
 * - 暴露 isPlatformUnsupportedError 让 UI 检测 web-server 路由未注册场景
 * - 暴露占位策略让 UI 在 try/catch 后给空状态文案
 */
export { PlatformUnsupportedError as WebPlatformUnsupportedError }
export { pickPlaceholder as webPickPlaceholder }

// keep types referenced
export type { GeneratedWebMethodSpec, WebMethodKind, WebPlaceholder }
