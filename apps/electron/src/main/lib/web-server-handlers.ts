/**
 * 把 WebServerManager 接到 IPC 通道。
 *
 * 调用方：main/index.ts 在 registerIpcHandlers() 之后调用
 *   registerWebServerHandlers(manager)
 */

import { ipcMain, BrowserWindow } from 'electron'
import type {
  WebServerSettings,
  WebServerStatusInfo,
  WebServerLogEntry,
} from '../../types/settings'
import {
  WEB_SERVER_IPC_CHANNELS,
  normalizeWebServerSettings,
} from '../../types/settings'
import type { WebServerManager } from './web-server-manager'

let activeManager: WebServerManager | null = null

export function registerWebServerHandlers(manager: WebServerManager): void {
  if (activeManager) return
  activeManager = manager

  // 把 settings 持久化到主进程已有的 settings 服务（getSettings/updateSettings）
  // 启动时同步一次磁盘上的 settings 到 manager
  const persisted = readPersisted()
  manager.updateSettings(persisted)

  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.GET_CONFIG, () => manager.getSettings())

  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.UPDATE_CONFIG, (_evt, raw: unknown) => {
    const normalized = normalizeWebServerSettings(raw)
    manager.updateSettings(normalized)
    writePersisted(normalized)
    return manager.getSettings()
  })

  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.START, async () => manager.start())
  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.STOP, async () => {
    await manager.stop()
    return { ok: true }
  })
  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.RESTART, async () => manager.restart())
  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.GET_STATUS, () => manager.getStatus())
  ipcMain.handle(WEB_SERVER_IPC_CHANNELS.GET_LOGS, (_evt, limit: unknown) => {
    const n = typeof limit === 'number' && limit > 0 && limit <= 1000 ? limit : 200
    return manager.getRecentLogs(n)
  })

  manager.on('status', (info: WebServerStatusInfo) => {
    broadcast(WEB_SERVER_IPC_CHANNELS.ON_STATUS_CHANGED, info)
  })
  manager.on('log', (entry: WebServerLogEntry) => {
    broadcast(WEB_SERVER_IPC_CHANNELS.ON_LOG, entry)
  })

  // autoStart 在 IPC 注册完成后由调用方显式触发
}

export function getWebServerManager(): WebServerManager | null {
  return activeManager
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// —— settings 持久化：复用 settings-service 的 getSettings/updateSettings ——
// 延迟 require 避免循环依赖
type LazySettings = typeof import('./settings-service')
let settingsService: LazySettings | undefined
function getSettingsService(): LazySettings {
  if (!settingsService) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    settingsService = require('./settings-service') as LazySettings
  }
  return settingsService
}

function readPersisted(): Partial<WebServerSettings> {
  const current = getSettingsService().getSettings()
  return current.webServer ?? {}
}

function writePersisted(value: WebServerSettings): void {
  getSettingsService().updateSettings({ webServer: value })
}