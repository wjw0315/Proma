/**
 * 系统级设置 domain（PR4 Bug3 D2）。
 *
 * 覆盖范围：
 * - web-server 自身的只读 introspection（get-config / get-status / get-logs）：
 *   Web 形态下 web-server 就是当前进程；从 env 推断 host/port/token，
 *   让用户在 WebServerSettings 页能看见自己跑在哪。
 * - 桌面专属能力（start/stop/restart/update-config / app-icon / voice-dictation /
 *   storage / chat-resource）抛 PlatformUnsupportedError：依赖 Electron runtime
 *   （BrowserWindow、safeStorage、systemPreferences、app.getPath），
 *   在 Bun 环境无法工作；UI 层用 isPlatformUnsupportedError 检测后给出降级提示。
 *
 * 不在本模块注册：
 * - web-server:* status-changed / log SSE 推送：在 web 形态下没有 manager 触发，
 *   前端 EventSource 订阅 channel 不会有事件推送，不影响 UI。
 */

import type { IpcHandler } from '../ipc-router'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import { loadConfig } from '../config'

/** 从 web-shim 的 args（位置参数数组或单值）取第 n 个参数。 */
function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 注册系统级设置通道。 */
export function registerSystemSettingsDomains(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== web-server 自身 introspection（只读）=====
  // 从当前进程的 env + config 推断 host/port/token 等。
  // 注：web-server 当前进程就是用户访问的这个 HTTP server，所以"自己在哪跑"
  // 等于 process.env + 启动 config 的合并。
  register('web-server:get-config', () => {
    const cfg = loadConfig()
    // loadConfig 内有 host/port 校验确保非空；token 可能是 null（loopback 无 token）
    return {
      host: cfg.host as string,
      port: cfg.port as number,
      token: cfg.token,
      requireTokenOnPublic: cfg.requireTokenOnPublic as boolean,
      requestTimeoutMs: cfg.requestTimeoutMs as number,
      sseIdleMs: cfg.sseIdleMs as number,
    }
  })

  register('web-server:get-status', () => {
    const cfg = loadConfig()
    // web-server 进程自身当然在 running；没有 manager 推 status 流，所以这是静态快照
    return {
      status: 'running' as const,
      pid: process.pid,
      bindAddress: `${cfg.host}:${cfg.port}`,
      startedAt: startedAtOnce(),
      lastChangedAt: Date.now(),
    }
  })

  register('web-server:get-logs', (args) => {
    const limit = arg(args, 0)
    // 没有持久化日志流；返回启动以来的固定提示（与主进程 WebServerLogEntry 同结构）
    const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50
    const now = Date.now()
    return Array.from({ length: n }, (_, i) => ({
      ts: now,
      stream: 'system' as const,
      message: LOG_BOOTSTRAP_PREFIX,
    }))
  })

  // ===== 桌面专属能力：Web 形态下不允许 manage 当前进程 =====
  const webServerUnsupported = (channelName: string, reason?: string) => () => {
    throw new PlatformUnsupportedError(
      channelName,
      reason ?? `Web 形态不支持 ${channelName}；当前 web-server 进程即是用户访问的 server，无法 manage 自己。请在桌面端管理。`,
    )
  }
  register('web-server:update-config', webServerUnsupported('web-server:update-config'))
  register('web-server:start', webServerUnsupported('web-server:start'))
  register('web-server:stop', webServerUnsupported('web-server:stop'))
  register('web-server:restart', webServerUnsupported('web-server:restart'))

  // ===== App 图标：macOS Dock 图标桌面专属 =====
  register('app-icon:set', (args) => {
    requireString(arg(args, 0), 'variantId')
    throw new PlatformUnsupportedError(
      'app-icon:set',
      'Web 形态不支持设置 Dock 图标（依赖 Electron app.dock.setIcon）。请在桌面端设置。',
    )
  })

  // ===== 语音输入：Bun 下 safeStorage 不可用 + 麦克风权限依赖 Electron systemPreferences =====
  const voiceDictationUnsupported = (channelName: string) => () => {
    throw new PlatformUnsupportedError(
      channelName,
      `Web 形态不支持 ${channelName}；语音输入需要 Electron safeStorage 加密 Access Token 与麦克风权限桌面能力。`,
    )
  }
  register('voice-dictation:get-settings', voiceDictationUnsupported('voice-dictation:get-settings'))
  register('voice-dictation:update-settings', voiceDictationUnsupported('voice-dictation:update-settings'))
  register('voice-dictation:test-connection', voiceDictationUnsupported('voice-dictation:test-connection'))
  register('voice-dictation:check-mic-permission', voiceDictationUnsupported('voice-dictation:check-mic-permission'))
  register('voice-dictation:request-mic-permission', voiceDictationUnsupported('voice-dictation:request-mic-permission'))
  // start / stop / toggle / preview / commit / send-audio / resize 等运行时操作
  // 未在 web-shim 生成表里出现但可能在调用链上，先覆盖主要的
  for (const ch of [
    'voice-dictation:start',
    'voice-dictation:stop',
    'voice-dictation:toggle',
    'voice-dictation:preview',
    'voice-dictation:commit',
    'voice-dictation:send-audio',
    'voice-dictation:resize',
    'voice-dictation:hide',
  ]) {
    register(ch, voiceDictationUnsupported(ch))
  }

  // ===== 存储清理：依赖 Electron app.getPath('temp') + safeStorage =====
  const storageUnsupported = (channelName: string) => () => {
    throw new PlatformUnsupportedError(
      channelName,
      `Web 形态不支持 ${channelName}；存储统计依赖 Electron app.getPath('temp')，清理依赖 safeStorage 加密文件。`,
    )
  }
  register('storage:get-stats', storageUnsupported('storage:get-stats'))
  register('storage:cleanup-temp', storageUnsupported('storage:cleanup-temp'))
  register('storage:cleanup', storageUnsupported('storage:cleanup'))

  // ===== Chat resource 文件保存：依赖 BrowserWindow + dialog =====
  register('chat:save-resource-file-as', () => {
    throw new PlatformUnsupportedError(
      'chat:save-resource-file-as',
      'Web 形态不支持 chat:save-resource-file-as；需要 BrowserWindow + dialog 弹原生保存对话框。',
    )
  })

  // 阻止 TS unused 警告
  void readString
}

// 让 getStatus 的 startedAt 在进程启动后稳定（避免每次调用返回不同值）
const startTime = Date.now()
function startedAtOnce(): number { return startTime }

const LOG_BOOTSTRAP_PREFIX = '[proma/web-server] running'
