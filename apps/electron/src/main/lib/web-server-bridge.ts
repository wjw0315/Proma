/**
 * WebServerBridge：Electron 主进程 ↔ web-server 子进程的 stdio JSONL 桥。
 *
 * 协议（与 apps/web-server/src/parent-bridge.ts 对应）：
 * - 子进程 stdout 上以 `#bridge#` 前缀行承载请求帧 {v:1,t:'req',id,m,p}
 * - 父进程往子进程 stdin 写响应帧 {v:1,t:'res',id,ok,r|e} 与事件帧 {v:1,t:'ev',ch,d}
 *
 * 职责：
 * 1. RPC 分发：Agent/Chat 运行时与渠道操作委托（web-server 在 Bun 里无法
 *    访问 Electron 运行时与 safeStorage）。
 * 2. 事件回流：agentEventBus 上所有会话事件转发给 web 客户端（SSE 同构通道），
 *    实现桌面端 ⇄ web 端消息实时同步。
 *
 * 生命周期：由 WebServerManager 在子进程 spawn 后 attach，子进程退出时 detach。
 */

import type { ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
  AgentQueueMessageInput,
  AgentQueuedMessageControlInput,
  PermissionResponse,
  AskUserResponse,
  PromaPermissionMode,
  ChatSendInput,
  ChannelDirectTestInput,
  FetchModelsInput,
} from '@proma/shared'
import {
  runAgent,
  stopAgent,
  queueAgentMessage,
  submitOrEnqueueAgentMessage,
  cancelAgentQueuedMessage,
  agentEventBus,
} from './agent-service'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { updateAgentSessionMeta, getAgentSessionMeta } from './agent-session-manager'
import { sendMessage as chatSendMessage } from './chat-service'
import {
  decryptApiKey,
  fetchModels,
  testChannel,
  testChannelDirect,
} from './channel-manager'

/** 与 web-server parent-bridge.ts 的 BRIDGE_FRAME_PREFIX 一致。 */
export const BRIDGE_FRAME_PREFIX = '#bridge#'

interface BridgeRequestFrame {
  v: 1
  t: 'req'
  id: string
  m: string
  p: unknown
}

interface BridgeResponseFrame {
  v: 1
  t: 'res'
  id: string
  ok: boolean
  r?: unknown
  e?: string
}

interface BridgeEventFrame {
  v: 1
  t: 'ev'
  ch: string
  d: unknown
}

/**
 * 桥视图下的“虚拟 WebContents”：runAgent/streamRoutes 只需要
 * isDestroyed() + send(channel, payload) 两个成员；把投递改写为桥事件。
 */
interface BridgeWebContents {
  isDestroyed(): boolean
  send(channel: string, payload?: unknown): void
}

export class WebServerBridge {
  private child: ChildProcess | null = null
  private stdin: Writable | null = null
  private detachAgentBus: (() => void) | null = null
  private bridgeTargets = new Map<string, BridgeWebContents>()

  /** spawn 成功后 attach：接管子进程 stdio。 */
  attach(child: ChildProcess): void {
    this.detach()
    this.child = child
    this.stdin = child.stdin ?? null
    const stdout = child.stdout
    if (stdout) {
      const rl = createInterface({ input: stdout })
      rl.on('line', (line: string) => {
        if (!line.startsWith(BRIDGE_FRAME_PREFIX)) return
        const raw = line.slice(BRIDGE_FRAME_PREFIX.length)
        try {
          const frame = JSON.parse(raw) as BridgeRequestFrame
          if (frame?.v === 1 && frame.t === 'req') {
            void this.dispatch(frame)
          }
        } catch {
          // 非法帧忽略，不影响子进程日志流
        }
      })
    }

    // 全局事件回流：所有 Agent 会话事件（含桌面端发起的运行）→ web 客户端
    this.detachAgentBus = agentEventBus.on((sessionId, payload) => {
      this.pushEvent(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
    })

    child.on('exit', () => this.detach())
  }

  detach(): void {
    this.detachAgentBus?.()
    this.detachAgentBus = null
    this.child = null
    this.stdin = null
    this.bridgeTargets.clear()
  }

  /** 桥是否处于可用状态（子进程存活且 stdin 可写）。 */
  isActive(): boolean {
    return this.child !== null && this.stdin !== null && this.stdin.writable
  }

  /** 往子进程写一帧。 */
  private writeFrame(frame: BridgeResponseFrame | BridgeEventFrame): void {
    if (!this.stdin?.writable) return
    try {
      this.stdin.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // 管道断裂（子进程退出中）：忽略
    }
  }

  /** 推送事件到 web 客户端（SSE 通道与 renderer web-shim 订阅一致）。 */
  /** 推送事件到 web 客户端（SSE 通道与 renderer web-shim 订阅一致）。公开给桌面端多播场景。 */
  publishToWeb(channel: string, data: unknown): void {
    this.pushEvent(channel, data)
  }

  private pushEvent(channel: string, data: unknown): void {
    this.writeFrame({ v: 1, t: 'ev', ch: channel, d: data })
  }

  /** RPC 分发。 */
  private async dispatch(frame: BridgeRequestFrame): Promise<void> {
    let ok = true
    let result: unknown
    let error: string | undefined
    try {
      result = await this.handle(frame.m, frame.p)
    } catch (err) {
      ok = false
      error = err instanceof Error ? err.message : String(err)
    }
    const response: BridgeResponseFrame = { v: 1, t: 'res', id: frame.id, ok }
    if (ok) response.r = result === undefined ? null : result
    else response.e = error ?? '未知错误'
    this.writeFrame(response)
  }

  private handle(method: string, params: unknown): Promise<unknown> | unknown {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      // ===== Agent 运行时 =====
      case 'agent.send':
        return this.handleAgentSend(p as unknown as AgentSendInput)
      case 'agent.stop':
        stopAgent(requireString(p.sessionId, 'sessionId'))
        return { ok: true }
      case 'agent.submitOrEnqueue': {
        const input = p as unknown as AgentSubmitOrEnqueueInput
        const target = this.getBridgeTarget(input.sessionId)
        return submitOrEnqueueAgentMessage(input, target as unknown as WebContents)
      }
      case 'agent.queueMessage': {
        const input = p as unknown as AgentQueueMessageInput
        const target = this.getBridgeTarget(input.sessionId)
        return queueAgentMessage(input, target as unknown as WebContents)
      }
      case 'agent.cancelQueuedMessage':
        return cancelAgentQueuedMessage(p as unknown as AgentQueuedMessageControlInput)
      case 'agent.permissionRespond': {
        const response = p as unknown as PermissionResponse
        const sessionId = permissionService.respondToPermission(
          response.requestId,
          response.behavior,
          response.alwaysAllow ?? false,
        )
        if (sessionId) {
          // 与 ipc.ts PERMISSION_RESPOND 一致：广播 resolved 事件
          this.pushEvent(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId,
            payload: {
              kind: 'proma_event',
              event: { type: 'permission_resolved', requestId: response.requestId, behavior: response.behavior },
            },
          })
          // 同时把桌面 renderer 的提示通道也走一遍（web-shim 订阅的是同一 SSE 通道）
        }
        return { ok: true, sessionId }
      }
      case 'agent.askUserRespond': {
        const response = p as unknown as AskUserResponse
        const sessionId = askUserService.respondToAskUser(response.requestId, response.answers)
        if (sessionId) {
          this.pushEvent(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId,
            payload: { kind: 'proma_event', event: { type: 'ask_user_resolved', requestId: response.requestId } },
          })
        }
        return { ok: true, sessionId }
      }
      case 'agent.updateSessionPermissionMode': {
        const sessionId = requireString(p.sessionId, 'sessionId')
        const mode = requireString(p.mode, 'mode') as PromaPermissionMode
        if (!getAgentSessionMeta(sessionId)) throw new Error(`会话不存在: ${sessionId}`)
        updateAgentSessionMeta(sessionId, { permissionMode: mode })
        return { ok: true }
      }

      // ===== Chat 运行时（在桌面端执行，密钥在 Electron 内解密）=====
      case 'chat.send': {
        const input = p as unknown as ChatSendInput
        // sink：多播到 web 客户端（桥事件 → SSE）。桌面 renderer 不在此路径上，
        // 若桌面端同时打开该对话，切换回去时从文件读取最新消息即可。
        const sink = {
          send: (channel: string, payload: unknown) => {
            this.pushEvent(channel, payload)
          },
        }
        const accepted = chatSendMessage(input, sink)
        return { ok: true, conversationId: input.conversationId, accepted }
      }

      // ===== 渠道操作（safeStorage 解密）=====
      case 'channel.decryptApiKey':
        return decryptApiKey(requireString(p.id, 'id'))
      case 'channel.test':
        return testChannel(requireString(p.id, 'id'))
      case 'channel.testDirect':
        return testChannelDirect(p as unknown as ChannelDirectTestInput)
      case 'channel.fetchModels':
        return fetchModels(p as unknown as FetchModelsInput)

      default:
        throw new Error(`桥方法未实现: ${method}`)
    }
  }

  /**
   * agent.send：用桥虚拟 WebContents 跑 runAgent。
   * 事件回流有三路保证：
   * 1. agentEventBus 全局订阅（attach 时注册）→ 所有事件 → SSE；
   * 2. runAgent 注册的 bridge target.send → STREAM_COMPLETE 等定向事件；
   * 3. 会话 meta 更新（runAgent 内部）由文件落盘，web 端刷新可见。
   */
  private async handleAgentSend(input: AgentSendInput): Promise<unknown> {
    const sessionId = requireString(input?.sessionId, 'sessionId')
    const target = this.getBridgeTarget(sessionId)
    await runAgent(input, target as unknown as WebContents)
    return { ok: true, sessionId }
  }

  /** 会话级虚拟 WebContents：同会话复用，保持 runAgent 的路由语义。 */
  private getBridgeTarget(sessionId: string): BridgeWebContents {
    let target = this.bridgeTargets.get(sessionId)
    if (!target || target.isDestroyed()) {
      target = this.createBridgeTarget()
      this.bridgeTargets.set(sessionId, target)
    }
    return target
  }

  private createBridgeTarget(): BridgeWebContents {
    return {
      isDestroyed: () => !this.isActive(),
      send: (channel: string, payload?: unknown) => {
        this.pushEvent(channel, payload)
      },
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

/** 进程级单例（与 WebServerManager 同生命周期）。 */
export const webServerBridge = new WebServerBridge()
