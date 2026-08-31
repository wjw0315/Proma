/**
 * WS 协议帧定义。
 * 客户端 -> 服务端：
 *   { type: 'input', data: string }
 *   { type: 'resize', cols: number, rows: number }
 *   { type: 'ack', seq: number }
 * 服务端 -> 客户端：
 *   { type: 'ready', pid: number, snapshotSeq?: number }
 *   { type: 'output', seq: number, data: string }
 *   { type: 'exit', code: number, signal?: number }
 *   { type: 'error', message: string }
 */

import type { IPty } from './pty-pool'

export type ClientFrame =
  | { type: 'input', data: string }
  | { type: 'resize', cols: number, rows: number }
  | { type: 'ack', seq: number }
  | { type: 'kill' }

export type ServerFrame =
  | { type: 'ready', pid: number, snapshotSeq: number, snapshot?: string }
  | { type: 'output', seq: number, data: string }
  | { type: 'exit', code: number, signal?: number }
  | { type: 'error', message: string }

export interface PtySessionContext {
  terminalId: string
  ws: WebSocket // Bun WS；服务端专用类型
}

export interface PtySessionHandlers {
  onInput(terminalId: string, data: string): void
  onResize(terminalId: string, cols: number, rows: number): void
  onAck(terminalId: string, seq: number): void
  onClose(terminalId: string): void
  /** 当前会话绑定的 pty 实例，用于 ready/snapshot/exit */
  resolvePty(): IPty | null
}