/**
 * agent 会话/工作区 domain（只读）：把 web-server IPC 通道接到主进程 lib 真实业务。
 *
 * 依赖链（agent-session-manager / agent-workspace-manager）经 electron
 * 延迟加载改造后零静态 Electron 依赖，可在 Bun 环境直接运行，读取与
 * Electron 主进程同一份 ~/.proma-agent-workspaces/ 数据。
 *
 * 范围限制：本模块只接**纯文件读取**通道。运行态通道
 * （active-sessions-snapshot 依赖 agent-service 的内存态、
 * send-agent-message / stop-agent 等需要 Agent runtime）不在此注册。
 */

import type { IpcHandler } from '../ipc-router'
import {
  listAgentSessions as libListSessions,
  listActiveAgentSessions as libListActive,
  listArchivedAgentSessions as libListArchived,
  getAgentSessionSDKMessages,
  createAgentSession as libCreateSession,
  updateAgentSessionMeta as libUpdateMeta,
  deleteAgentSession as libDeleteSession,
} from '../../../electron/src/main/lib/agent-session-manager'
import {
  listAgentWorkspaces as libListWorkspaces,
  getAgentWorkspaceBySlug,
} from '../../../electron/src/main/lib/agent-workspace-manager'

/** 注册 agent 会话/工作区只读通道。 */
export function registerAgentSessionsDomain(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== 工作区 =====
  register('agent:list-workspaces', () => libListWorkspaces())

  // ===== 会话列表（读 JSONL 索引） =====
  register('agent:list-sessions', () => libListSessions())
  register('agent:list-active-sessions', () => libListActive())
  register('agent:list-archived-sessions', () => libListArchived())
  register('agent:count-archived-sessions', () => libListArchived().length)

  // ===== 单会话元数据 =====
  register('agent:get-sdk-messages', (args) => {
    const id = Array.isArray(args) ? args[0] : args
    if (typeof id !== 'string' || !id.trim()) throw new Error('sessionId 必填')
    // 仅读取已落盘 SDK 消息；不触达运行态
    return getAgentSessionSDKMessages(id)
  })

  // ===== 会话写操作（JSONL 索引；不含 Agent 运行时启动） =====
  register('agent:create-session', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const [title, channelId, workspaceId, modelId, isDraft] = a
    if (isDraft !== undefined && typeof isDraft !== 'boolean') throw new Error('Agent 草稿状态非法')
    // 与主进程 CREATE_SESSION 对齐：feishuMirror 等副作用不在此重复
    return libCreateSession(
      typeof title === 'string' ? title : undefined,
      typeof channelId === 'string' ? channelId : undefined,
      typeof workspaceId === 'string' ? workspaceId : undefined,
      typeof modelId === 'string' ? modelId : undefined,
      undefined,
      undefined,
      isDraft,
    )
  })
  register('agent:update-title', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const id = a[0], title = a[1]
    if (typeof id !== 'string' || !id.trim()) throw new Error('id 必填')
    if (typeof title !== 'string' || !title.trim()) throw new Error('title 必填')
    return libUpdateMeta(id, { title })
  })
  register('agent:update-session-model', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const id = a[0], channelId = a[1], modelId = a[2]
    if (typeof id !== 'string' || !id.trim()) throw new Error('id 必填')
    return libUpdateMeta(id, {
      ...(typeof channelId === 'string' ? { channelId } : {}),
      ...(typeof modelId === 'string' ? { modelId } : {}),
    })
  })
  const toggleField = (field: 'pinned' | 'starred' | 'archived') => (args: unknown) => {
    const id = Array.isArray(args) ? args[0] : args
    if (typeof id !== 'string' || !id.trim()) throw new Error('id 必填')
    const current = libListSessions().find((s) => s.id === id)
    if (!current) throw new Error(`Agent 会话不存在: ${id}`)
    return libUpdateMeta(id, { [field]: !current[field] })
  }
  register('agent:toggle-pin', toggleField('pinned'))
  register('agent:toggle-star', toggleField('starred'))
  register('agent:toggle-archive', toggleField('archived'))
  register('agent:delete-session', (args) => {
    const id = Array.isArray(args) ? args[0] : args
    if (typeof id !== 'string' || !id.trim()) throw new Error('id 必填')
    libDeleteSession(id)
    return { ok: true }
  })

  // ===== 工作区能力（读 skills/mcp 配置；无 Electron 副作用） =====
  register('agent:get-workspace-capabilities', (args) => {
    const slug = Array.isArray(args) ? args[0] : args
    if (typeof slug !== 'string' || !slug.trim()) throw new Error('workspaceSlug 必填')
    const ws = getAgentWorkspaceBySlug(slug)
    if (!ws) throw new Error(`工作区不存在：${slug}`)
    // 与主进程 getWorkspaceCapabilities 对齐的最小实现：
    // 返回工作区基础信息；skills/mcp 明细由各自通道（后续 PR）接入
    return {
      workspace: {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        projectRootPath: ws.projectRootPath,
      },
    }
  })
}
