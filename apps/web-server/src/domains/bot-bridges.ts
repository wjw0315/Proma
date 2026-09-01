/**
 * 飞书 / 钉钉 / 企业微信 bridge domain（PR7 Bug3 D6）。
 *
 * Web 形态策略：
 * - **只读（部分接入）**：Feishu/DingTalk/WeChat 的 get-config / get-status / get-multi-config /
 *   get-multi-status / list-bindings 不解密安全字段，直接读 ~/.proma/{feishu,dingtalk,wechat}.json
 *   的明文 JSON 暴露给 web 前端。appSecret / credentials 等敏感字段保持加密态(base64 字符串)
 *   —— web 端不调用 safeStorage，避免主进程 lib 的 Bun safeStorage 缺失导致 import 失败。
 * - **网络执行/启动/凭据解密/写操作（全部降级）**：runtime bridge、bot 启停、test-connection、
 *   save-config、remove-bot、start-oauth、解密 secret 等依赖主进程 Electron runtime 或
 *   safeStorage，抛 PlatformUnsupportedError；UI 层用 isPlatformUnsupportedError 检测后
 *   引导用户到桌面端。
 *
 * 与 PR4/voice-dictation 同根：主进程业务模块（feishu-config.ts / dingtalk-config.ts /
 * wechat-config.ts / 三个 bridge.ts / 三个 bridge-manager.ts）都在模块顶层 `import { safeStorage } from 'electron'`
 * 或 import `BrowserWindow`，Bun 环境无法直接 import 整模块，所以本模块独立读取
 * 配置文件 JSON（跳过加密层），并不解密安全字段。
 *
 * 不在本模块注册：
 * - Feishu/DingTalk/WeChat 的 status-changed / presence SSE：web 形态无运行时
 *   推流；前端 EventSource 订阅 channel 不会有事件推送，不影响 UI。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IpcHandler } from '../ipc-router'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import { getFeishuConfigPath, getDingTalkConfigPath, getWeChatConfigPath } from '../../../electron/src/main/lib/config-paths'

/** 安全读取 + 解析 JSON 文件；不存在或解析失败返回 fallback。 */
function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ===== 飞书只读 =====
// 真实结构（v2）：{ version: 2, bots: [{ id, name, enabled, appId, appSecret, defaultWorkspaceId, domain }] }
// 兼容 v1：{ enabled, appId, appSecret, domain, defaultWorkspaceId }
interface FeishuMultiBotConfig {
  version?: number
  bots?: FeishuBotEntry[]
  // v1 兼容字段
  enabled?: boolean
  appId?: string
  appSecret?: string
  domain?: string
  defaultWorkspaceId?: string
}
interface FeishuBotEntry {
  id?: string
  name?: string
  enabled?: boolean
  appId?: string
  appSecret?: string
  domain?: string
  defaultWorkspaceId?: string
}
function readFeishuMulti(): FeishuMultiBotConfig {
  return readJsonFile<FeishuMultiBotConfig>(getFeishuConfigPath(), {})
}
function readFeishuSingle(): FeishuBotEntry {
  const multi = readFeishuMulti()
  if (multi.bots && multi.bots.length > 0) {
    const first = multi.bots[0]!
    return {
      id: first.id,
      name: first.name,
      enabled: first.enabled,
      appId: first.appId,
      appSecret: first.appSecret, // 保持加密态（base64 字符串）
      domain: first.domain,
      defaultWorkspaceId: first.defaultWorkspaceId,
    }
  }
  // v1 兼容
  if (multi.enabled !== undefined || multi.appId) {
    return {
      enabled: multi.enabled,
      appId: multi.appId,
      appSecret: multi.appSecret,
      domain: multi.domain,
      defaultWorkspaceId: multi.defaultWorkspaceId,
    }
  }
  return { enabled: false, appId: '', appSecret: '' }
}

// ===== 钉钉只读 =====
// 结构：{ bots: { [botId]: { id, name, clientId, clientSecret, robotCode, ... } } }
interface DingTalkConfig {
  bots?: Record<string, DingTalkBotEntry>
  enabled?: boolean
  clientId?: string
  clientSecret?: string
}
interface DingTalkBotEntry {
  id?: string
  name?: string
  enabled?: boolean
  clientId?: string
  clientSecret?: string
  robotCode?: string
}
function readDingTalkMulti(): DingTalkConfig {
  return readJsonFile<DingTalkConfig>(getDingTalkConfigPath(), {})
}
function readDingTalkSingle(): DingTalkConfig {
  const multi = readDingTalkMulti()
  if (multi.bots && Object.keys(multi.bots).length > 0) {
    const firstId = Object.keys(multi.bots)[0]!
    const first = multi.bots[firstId]!
    return {
      bots: { [firstId]: first },
      enabled: first.enabled,
      clientId: first.clientId,
    }
  }
  // v1 兼容
  if (multi.clientId) {
    return {
      enabled: multi.enabled,
      clientId: multi.clientId,
    }
  }
  return { enabled: false }
}

// ===== 企业微信只读 =====
// 结构：{ enabled, credentials: { botToken, ilinkBotId, baseUrl, ilinkUserId }, defaultWorkspaceId }
interface WeChatConfig {
  enabled?: boolean
  credentials?: {
    botToken?: string
    ilinkBotId?: string
    baseUrl?: string
    ilinkUserId?: string
  }
  defaultWorkspaceId?: string
}
function readWeChat(): WeChatConfig {
  return readJsonFile<WeChatConfig>(getWeChatConfigPath(), {})
}

// ===== 通用降级工厂 =====
function runtimeUnsupported(channelName: string, kind: string = '启动/凭据/网络'): () => never {
  return () => {
    throw new PlatformUnsupportedError(
      channelName,
      `Web 形态不支持 ${channelName}；飞书/钉钉/企业微信是 ${kind} 桌面专属能力。`,
    )
  }
}

/** 注册飞书 / 钉钉 / 企业微信只读 + 降级通道。 */
export function registerBotBridgeDomains(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== 飞书只读 =====
  register('feishu:get-config', () => readFeishuSingle())
  register('feishu:get-multi-config', () => readFeishuMulti())
  register('feishu:get-status', () => {
    // web 端没有运行时连接；只读 config 反映"已配置"状态
    const single = readFeishuSingle()
    return {
      status: single.appId ? 'configured' as const : 'disconnected' as const,
      activeBindings: 0,
    }
  })
  register('feishu:get-multi-status', () => {
    const multi = readFeishuMulti()
    const bots = multi.bots ?? []
    return bots.map((b) => ({
      botId: b.id,
      status: (b.appId ? 'configured' : 'disconnected') as 'configured' | 'disconnected',
      activeBindings: 0,
    }))
  })
  register('feishu:list-bindings', () => {
    // 飞书绑定（chat ↔ session）由运行时维护；web 端静态读不到真实运行状态
    // 仍返回空数组，让 UI 不报错
    return []
  })
  register('feishu:get-decrypted-secret', runtimeUnsupported('feishu:get-decrypted-secret', '凭据解密'))
  register('feishu:get-bot-decrypted-secret', runtimeUnsupported('feishu:get-bot-decrypted-secret', '凭据解密'))
  register('feishu:report-presence', runtimeUnsupported('feishu:report-presence', '网络'))

  // ===== 钉钉只读 =====
  register('dingtalk:get-config', () => readDingTalkSingle())
  register('dingtalk:get-multi-config', () => readDingTalkMulti())
  register('dingtalk:get-status', () => {
    const single = readDingTalkSingle()
    return {
      status: single.clientId ? 'configured' as const : 'disconnected' as const,
      activeBots: single.bots ? Object.keys(single.bots).length : 0,
    }
  })
  register('dingtalk:get-multi-status', () => {
    const multi = readDingTalkMulti()
    const bots = multi.bots ?? {}
    return Object.entries(bots).map(([botId, b]) => ({
      botId,
      status: (b.clientId ? 'configured' : 'disconnected') as 'configured' | 'disconnected',
    }))
  })
  register('dingtalk:get-decrypted-secret', runtimeUnsupported('dingtalk:get-decrypted-secret', '凭据解密'))
  register('dingtalk:get-bot-decrypted-secret', runtimeUnsupported('dingtalk:get-bot-decrypted-secret', '凭据解密'))

  // ===== 企业微信只读 =====
  register('wechat:get-config', () => readWeChat())
  register('wechat:get-status', () => {
    const cfg = readWeChat()
    return {
      status: cfg.credentials ? 'configured' as const : 'disconnected' as const,
    }
  })

  // ===== 全部启动/写/网络操作降级（飞书/钉钉/企业微信同名降级） =====
  // 飞书
  register('feishu:save-config', runtimeUnsupported('feishu:save-config', '写'))
  register('feishu:save-bot-config', runtimeUnsupported('feishu:save-bot-config', '写'))
  register('feishu:remove-bot', runtimeUnsupported('feishu:remove-bot', '写'))
  register('feishu:start-bot', runtimeUnsupported('feishu:start-bot', '启动'))
  register('feishu:stop-bot', runtimeUnsupported('feishu:stop-bot', '启动'))
  register('feishu:test-connection', runtimeUnsupported('feishu:test-connection', '网络'))
  register('feishu:update-binding', runtimeUnsupported('feishu:update-binding', '写'))
  register('feishu:remove-binding', runtimeUnsupported('feishu:remove-binding', '写'))
  register('feishu:register-app-start', runtimeUnsupported('feishu:register-app-start', '网络'))
  register('feishu:register-app-qrcode', runtimeUnsupported('feishu:register-app-qrcode', '网络'))
  register('feishu:register-app-status', runtimeUnsupported('feishu:register-app-status', '网络'))
  register('feishu:register-app-cancel', runtimeUnsupported('feishu:register-app-cancel', '网络'))

  // 钉钉
  register('dingtalk:save-config', runtimeUnsupported('dingtalk:save-config', '写'))
  register('dingtalk:save-bot-config', runtimeUnsupported('dingtalk:save-bot-config', '写'))
  register('dingtalk:remove-bot', runtimeUnsupported('dingtalk:remove-bot', '写'))
  register('dingtalk:start-bridge', runtimeUnsupported('dingtalk:start-bridge', '启动'))
  register('dingtalk:stop-bridge', runtimeUnsupported('dingtalk:stop-bridge', '启动'))
  register('dingtalk:start-bot', runtimeUnsupported('dingtalk:start-bot', '启动'))
  register('dingtalk:stop-bot', runtimeUnsupported('dingtalk:stop-bot', '启动'))
  register('dingtalk:test-connection', runtimeUnsupported('dingtalk:test-connection', '网络'))

  // 企业微信
  register('wechat:start-bridge', runtimeUnsupported('wechat:start-bridge', '启动'))
  register('wechat:stop-bridge', runtimeUnsupported('wechat:stop-bridge', '启动'))
  register('wechat:start-login', runtimeUnsupported('wechat:start-login', '启动'))
  register('wechat:logout', runtimeUnsupported('wechat:logout', '写'))
}
