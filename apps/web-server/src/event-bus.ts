/**
 * 应用内事件总线：被业务层调用，把事件推到 SSE。
 *
 * 设计：
 * - 单一内存 EventEmitter，所有订阅者按 channel 区分
 * - Web 客户端经 SSE /api/events?channel=xxx 订阅
 * - 业务层通过 publish(channel, payload) 推送
 *
 * 暂未集成主进程 lib 的 event bus；Step 7 完成集成。
 */

import { EventEmitter } from 'node:events'

export interface PromaWebEvent {
  channel: string
  data: unknown
  ts: number
}

class WebEventBus {
  private readonly emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(0)
  }

  publish(channel: string, data: unknown): void {
    const event: PromaWebEvent = { channel, data, ts: Date.now() }
    this.emitter.emit(channel, event)
  }

  subscribe(channel: string, handler: (event: PromaWebEvent) => void): () => void {
    this.emitter.on(channel, handler)
    return () => this.emitter.off(channel, handler)
  }
}

export const webEventBus = new WebEventBus()