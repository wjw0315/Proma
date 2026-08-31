/**
 * 平台抽象层类型定义。
 *
 * 设计原则：
 * 1. 只抽象 renderer 调用主进程的契约，不关心底层是 IPC / fetch / WS
 * 2. 单向 request/response、单向 subscribe（主进程推送）、双向 stream（终端 PTY）三类
 * 3. 类型尽量与现有 IPC_CHANNELS / TERMINAL_IPC_CHANNELS 保持兼容，便于渐进迁移
 */

import type { TERMINAL_IPC_CHANNELS } from '@proma/shared'

/** 平台形态标识 */
export type PlatformKind = 'electron' | 'web'

/** 平台能力声明；Step 5 用 */
export interface PlatformCapabilities {
  /** 系统托盘 */
  readonly hasTray: boolean
  /** 原生应用菜单 */
  readonly hasNativeMenu: boolean
  /** macOS EventKit（日历/提醒） */
  readonly hasEventKit: boolean
  /** 自动更新 */
  readonly hasAutoUpdate: boolean
  /** shell.openPath / openExternal */
  readonly hasShellOpen: boolean
  /** 原生文件/目录选择对话框 */
  readonly hasFileDialog: boolean
  /** 完整 PTY（Electron 用本地 node-pty，Web 用服务端 node-pty） */
  readonly hasPty: boolean
}

/** 单次调用：request -> response */
export interface PlatformRequest {
  <TResponse = unknown>(channel: string, args?: unknown): Promise<TResponse>
}

/** 单向订阅：主进程向 renderer 推送事件 */
export interface PlatformSubscribe {
  <TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): () => void
}

/**
 * 双向流通道。
 * 用于终端 PTY：客户端可发送 input/resize/kill，服务端推送 output/exit。
 * 帧协议复用 TERMINAL_IPC_CHANNELS 现有 input/output 形状。
 */
export interface PlatformBidirectionalChannel {
  /** 发送一帧（任意可序列化对象） */
  send(frame: unknown): void
  /** 接收一帧 */
  onMessage(handler: (frame: unknown) => void): () => void
  /** 关闭通道 */
  close(): void
  /** 通道状态 */
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
}

export interface PlatformBidirectionalFactory {
  (channel: typeof TERMINAL_IPC_CHANNELS[keyof typeof TERMINAL_IPC_CHANNELS], options?: {
    terminalId?: string
    sessionId?: string
  }): PlatformBidirectionalChannel
}

/** 平台 API 完整契约，renderer 只依赖这个接口 */
export interface PlatformAPI {
  readonly kind: PlatformKind
  readonly capabilities: PlatformCapabilities
  readonly request: PlatformRequest
  readonly subscribe: PlatformSubscribe
  readonly openStream: PlatformBidirectionalFactory
}