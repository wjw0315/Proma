/**
 * 父进程桥接 domain：把 Agent / Chat 运行时通道委托给 Electron 主进程执行。
 *
 * 为什么委托而不是在 web-server（Bun）里重跑运行时：
 * - Agent runtime（Pi adapter、权限、队列、飞书镜像、会话启动锁）深度耦合
 *   Electron 主进程内存态；chat 运行时同理。
 * - safeStorage 解密只能在 Electron（OS keychain）做；web-server 直接调
 *   provider 会拿密文当 key（401）。
 * - 双端一致性：运行时只有一个（桌面端），web 只是另一个视图，事件经桥
 *   流回 SSE，天然解决 web/桌面消息同步。
 *
 * 通道在桥可用（嵌入模式）时注册；独立模式下不注册，保持
 * PlatformUnsupportedError 语义（前端已有降级提示）。
 *
 * 事件回流：Electron 侧把 STREAM_* 事件按 SSE 通道名推回
 * （agent:stream:event / chat:stream:* 等），由 parent-bridge 广播到
 * webEventBus，前端 web-shim 经 EventSource 订阅，与桌面端 IPC 同构。
 */

import type { IpcHandler } from '../ipc-router'
import { register as registerChannel } from '../ipc-router'
import {
  isParentBridgeEnabled,
  bridgeRequest,
} from '../parent-bridge'

function arg0(args: unknown): unknown {
  return Array.isArray(args) ? args[0] : args
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error(`${what} 需要对象参数`)
  return value as Record<string, unknown>
}

/** 注册桥接通道。独立模式下不注册。 */
export function registerParentBridgeDomains(): void {
  if (!isParentBridgeEnabled()) return

  // ===== Agent 运行时 =====
  // 发送消息：委托父进程 runAgent（含权限/队列/飞书镜像/启动锁），事件经桥回流。
  registerChannel('agent:send-message', (args) => {
    const input = requireObject(arg0(args), 'agent:send-message')
    return bridgeRequest('agent.send', input)
  })

  // 停止生成：委托父进程 stopAgent。
  registerChannel('agent:stop', (args) => {
    const sessionId = arg0(args)
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId 必填')
    return bridgeRequest('agent.stop', { sessionId })
  })

  // 排队消息的原子注入/排队决策与取消也走父进程（依赖其内存态队列）
  registerChannel('agent:submit-or-enqueue-message', (args) => {
    const input = requireObject(arg0(args), 'agent:submit-or-enqueue-message')
    return bridgeRequest('agent.submitOrEnqueue', input)
  })
  registerChannel('agent:queue-message', (args) => {
    const input = requireObject(arg0(args), 'agent:queue-message')
    return bridgeRequest('agent.queueMessage', input)
  })
  registerChannel('agent:cancel-queued-message', (args) => {
    const input = requireObject(arg0(args), 'agent:cancel-queued-message')
    return bridgeRequest('agent.cancelQueuedMessage', input)
  })

  // 权限 / AskUser 应答：web 端 Banner 点击 → 父进程 permissionService / askUserService
  registerChannel('agent:permission:respond', (args) => {
    const response = requireObject(arg0(args), 'agent:permission:respond')
    return bridgeRequest('agent.permissionRespond', response)
  })
  registerChannel('agent:ask-user:respond', (args) => {
    const response = requireObject(arg0(args), 'agent:ask-user:respond')
    return bridgeRequest('agent.askUserRespond', response)
  })
  // 运行中热切权限模式
  registerChannel('agent:update-session-permission-mode', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const sessionId = a[0]
    const mode = a[1]
    if (typeof sessionId !== 'string' || typeof mode !== 'string') throw new Error('参数非法')
    return bridgeRequest('agent.updateSessionPermissionMode', { sessionId, mode })
  })

  // ===== Chat 运行时（替换本地 chatSendHandler，统一走桌面端）=====
  // 注：chat-channels.ts 的本地实现保留作独立模式兜底；桥模式在这里覆盖注册。
  // ipc-router 的 register 不允许重复注册，因此本函数必须在
  // registerChatAndChannelsDomains 之后调用（见 ipc-router.ts 装配顺序）。
  // —— 但 register 会抛「重复注册」，所以改由 ipc-router 移除后重注册。
  registerChannelOverride('chat:send-message', async (args) => {
    const input = requireObject(arg0(args), 'chat:send-message')
    const result = await bridgeRequest<{ ok: boolean; conversationId: string; accepted: boolean }>('chat.send', input)
    return result
  })

  // ===== 需要解密 API Key 的渠道操作（Bun 下无法解密 safeStorage 密文，委托父进程）=====
  registerChannelOverride('channel:test', (args) => {
    const id = arg0(args)
    if (typeof id !== 'string' || !id) throw new Error('id 必填')
    return bridgeRequest('channel.test', { id })
  })
  registerChannelOverride('channel:test-direct', (args) => {
    const input = requireObject(arg0(args), 'channel:test-direct')
    return bridgeRequest('channel.testDirect', input)
  })
  registerChannelOverride('channel:fetch-models', (args) => {
    const input = requireObject(arg0(args), 'channel:fetch-models')
    return bridgeRequest('channel.fetchModels', input)
  })

  // ===== 解密 API Key（设置页查看密钥等场景）=====
  registerChannelOverride('channel:decrypt-api-key', (args) => {
    const id = arg0(args)
    if (typeof id !== 'string' || !id) throw new Error('id 必填')
    return bridgeRequest('channel.decryptApiKey', { id })
  })
}

// ipc-router 暴露的 register 拒绝重复；桥模式需要覆盖 chat:send-message 的本地实现。
// 这里用一个受控的 override：先删再注册。
type RegisterFn = <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void
interface OverridableRegistry {
  unregister(channel: string): boolean
}

let overrideTarget: RegisterFn | null = null
let registryRef: OverridableRegistry | null = null

/** 由 ipc-router 注入可覆盖注册能力（避免 router 暴露 Map 本体）。 */
export function bindRegistryOverride(register: RegisterFn, registry: OverridableRegistry): void {
  overrideTarget = register
  registryRef = registry
}

function registerChannelOverride(channel: string, handler: IpcHandler): void {
  if (!overrideTarget || !registryRef) {
    throw new Error('registerParentBridgeDomains 需要 ipc-router 先 bindRegistryOverride')
  }
  registryRef.unregister(channel)
  overrideTarget(channel, handler)
}

// —— 内部再导出方便测试 ——
export { bridgeRequest as _bridgeRequestForTest }
