/**
 * chat 会话 + channels domain：把 web-server IPC 通道接到主进程 lib 真实业务。
 *
 * - conversation-manager：纯 JSON 文件（对话索引 + 消息），依赖闭包经
 *   attachment-service 延迟加载改造后在 Bun 下可加载
 * - channel-manager：channels.json；listChannels 返回的 apiKey 保持加密态，
 *   与 Electron 主进程语义一致（Web 端不需要也不应拿到明文 key）
 *
 * 范围限制：chat:send-message（AI 流式）仍为 echo 占位（由 SSE event-bus PR 接入）；
 * decrypt-api-key / oauth 等涉密/桌面能力不在此注册。
 */

import type { IpcHandler } from '../ipc-router'
import {
  listConversations as libList,
  createConversation as libCreate,
  getConversationMessages as libGetMessages,
  getRecentMessages as libGetRecent,
  updateConversationMeta as libUpdateMeta,
  deleteConversation as libDelete,
  deleteMessage as libDeleteMessage,
  updateContextDividers as libUpdateDividers,
} from '../../../electron/src/main/lib/conversation-manager'
import { listChannels as libListChannels } from '../../../electron/src/main/lib/channel-manager'

/** 从 web-shim 的 args（位置参数数组或单值）取第 n 个参数。 */
function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

/** 注册 chat 会话 + channels 通道。 */
export function registerChatAndChannelsDomains(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== chat 会话索引 =====
  register('chat:list-conversations', () => libList())
  register('chat:create-conversation', (args) => {
    const title = arg(args, 0)
    const modelId = arg(args, 1)
    const channelId = arg(args, 2)
    return libCreate(
      typeof title === 'string' ? title : undefined,
      typeof modelId === 'string' ? modelId : undefined,
      typeof channelId === 'string' ? channelId : undefined,
    )
  })
  register('chat:get-messages', (args) => libGetMessages(requireString(arg(args, 0), 'id')))
  register('chat:get-recent-messages', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const limit = arg(args, 1)
    return libGetRecent(id, typeof limit === 'number' && limit > 0 ? limit : 20)
  })
  register('chat:update-title', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const title = requireString(arg(args, 1), 'title')
    return libUpdateMeta(id, { title })
  })
  register('chat:update-conversation-model', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const modelId = requireString(arg(args, 1), 'modelId')
    const channelId = requireString(arg(args, 2), 'channelId')
    return libUpdateMeta(id, { modelId, channelId })
  })
  register('chat:toggle-pin', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const current = libList().find((c) => c.id === id)
    if (!current) throw new Error(`对话不存在: ${id}`)
    return libUpdateMeta(id, { pinned: !current.pinned })
  })
  register('chat:toggle-archive', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const current = libList().find((c) => c.id === id)
    if (!current) throw new Error(`对话不存在: ${id}`)
    return libUpdateMeta(id, { archived: !current.archived })
  })
  register('chat:delete-conversation', (args) => {
    libDelete(requireString(arg(args, 0), 'id'))
    return { ok: true }
  })
  register('chat:delete-message', (args) => {
    const conversationId = requireString(arg(args, 0), 'conversationId')
    const messageId = requireString(arg(args, 1), 'messageId')
    return libDeleteMessage(conversationId, messageId)
  })
  register('chat:update-context-dividers', (args) => {
    const conversationId = requireString(arg(args, 0), 'conversationId')
    const raw = arg(args, 1)
    const dividers = Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : []
    return libUpdateDividers(conversationId, dividers)
  })

  // ===== channels（apiKey 保持加密态，与主进程 listChannels 语义一致） =====
  register('channel:list', () => libListChannels())
}
