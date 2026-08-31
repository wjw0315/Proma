/**
 * Electron 形态的 PlatformAPI 实现。
 *
 * 适配规则：
 * - ipcMain.handle 走 window.electronAPI.x(args) -> Promise<T>
 * - ipcMain.on 推送走现有 subscribe 风格的 channel
 * - 双向流：当前 Electron 通过 terminal-service 的 IPC 一来一回实现，
 *   renderer 端已经在 preload 暴露 createTerminalStream；这里包装为 openStream
 *
 * 设计：不再直接绑 window.electronAPI，而是消费 preload 暴露的 bridge。
 * 这样 renderer 在迁移期间可以双轨运行，electronAPI 保留以便逐步替换。
 */

import type {
  PlatformAPI,
  PlatformCapabilities,
  PlatformBidirectionalChannel,
  PlatformBidirectionalFactory,
  PlatformRequest,
  PlatformSubscribe,
} from './types'
import type { TERMINAL_IPC_CHANNELS } from '@proma/shared'

const ELECTRON_CAPABILITIES: PlatformCapabilities = {
  hasTray: true,
  hasNativeMenu: true,
  hasEventKit: true,
  hasAutoUpdate: true,
  hasShellOpen: true,
  hasFileDialog: true,
  hasPty: true,
}

/** preload 暴露给 renderer 的桥；保留与现有 window.electronAPI 兼容 */
export interface ElectronBridge {
  request<TResponse = unknown>(channel: string, args?: unknown): Promise<TResponse>
  subscribe<TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): () => void
  openTerminalStream(input: { terminalId: string; sessionId?: string }): {
    send(frame: unknown): void
    onMessage(handler: (frame: unknown) => void): () => void
    close(): void
    readyState: 'connecting' | 'open' | 'closing' | 'closed'
  }
  capabilities: PlatformCapabilities
}

export function createElectronPlatform(bridge: ElectronBridge): PlatformAPI {
  const request: PlatformRequest = (channel, args) => bridge.request(channel, args)
  const subscribe: PlatformSubscribe = (channel, handler) =>
    bridge.subscribe(channel, handler)

  const openStream: PlatformBidirectionalFactory = (channel, options) => {
    if (!options?.terminalId) {
      throw new Error('openStream requires terminalId for Electron terminal channels')
    }
    return bridge.openTerminalStream({
      terminalId: options.terminalId,
      sessionId: options.sessionId,
    }) as PlatformBidirectionalChannel
  }

  return {
    kind: 'electron',
    capabilities: bridge.capabilities ?? ELECTRON_CAPABILITIES,
    request,
    subscribe,
    openStream,
  }
}

/** 用于 contextBridge.exposeInMainWorld 的常量名 */
export const PLATFORM_API_WINDOW_KEY = 'promaPlatformAPI' as const