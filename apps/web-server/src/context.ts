/**
 * 请求级 context。每个 IPC 请求和 SSE 订阅都拿到一份；
 * 含 traceId、当前工作区、用户路径、事件总线等。
 */

import type { webEventBus } from './event-bus'

export interface WebServerContext {
  traceId: string
  userDataDir: string
  workspaceSlug?: string
  /** 让 handler 直接 publish / subscribe */
  eventBus: typeof webEventBus
  /** 让 handler 写日志 */
  log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void
}

let traceCounter = 0

export function newTraceId(): string {
  traceCounter += 1
  return `${Date.now().toString(36)}-${traceCounter.toString(36)}`
}