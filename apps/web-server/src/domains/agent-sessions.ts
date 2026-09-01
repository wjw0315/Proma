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
  getAgentWorkspace as libGetAgentWorkspace,
  getAgentWorkspaceBySlug,
  getWorkspaceMcpConfig as libGetWorkspaceMcpConfig,
  saveWorkspaceMcpConfig as libSaveWorkspaceMcpConfig,
  listSkillFiles as libListSkillFiles,
  readSkillFile as libReadSkillFile,
  writeSkillFile as libWriteSkillFile,
  createSkillEntry as libCreateSkillEntry,
  deleteSkillEntry as libDeleteSkillEntry,
  renameSkillEntry as libRenameSkillEntry,
  deleteWorkspaceSkill as libDeleteWorkspaceSkill,
  toggleWorkspaceSkill as libToggleWorkspaceSkill,
  getWorkspaceMemorySummary as libGetWorkspaceMemorySummary,
  readWorkspaceAgentsMd as libReadWorkspaceAgentsMd,
  writeWorkspaceAgentsMd as libWriteWorkspaceAgentsMd,
  listWorkspaceAutoMemoryFiles as libListWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile as libReadWorkspaceAutoMemoryFile,
  writeWorkspaceAutoMemoryFile as libWriteWorkspaceAutoMemoryFile,
} from '../../../electron/src/main/lib/agent-workspace-manager'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import { getAgentSessionWorkspacePath } from '../../../electron/src/main/lib/config-paths'

/** 从 web-shim 的 args（位置参数数组或单值）取第 n 个参数。 */
function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

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

  // ===== Agent 会话工作路径（右侧 SidePanel 依赖） =====
  // 与主进程 ipc.ts GET_SESSION_PATH handler 对齐：
  // workspaceId 查不到 workspace 时返回 null（与主进程一致）；
  // 否则返回 ~/.proma/agent-workspaces/{slug}/{sessionId}/ 并确保目录存在。
  register('agent:get-session-path', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const workspaceId = a[0]
    const sessionId = a[1]
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspaceId 必填')
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId 必填')
    const ws = libGetAgentWorkspace(workspaceId)
    if (!ws) return null
    return getAgentSessionWorkspacePath(ws.slug, sessionId)
  })

  // ===== Skills CRUD（纯 fs；agent-workspace-manager.ts 零 Electron 依赖）=====
  // arity 2 / 3 / 4：参数是 (workspaceSlug, skillSlug[, relativePath[, content]])
  register('agent:list-skill-files', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libListSkillFiles(requireString(a[0], 'workspaceSlug'), requireString(a[1], 'skillSlug'))
  })
  register('agent:read-skill-file', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libReadSkillFile(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      requireString(a[2], 'relativePath'),
    )
  })
  register('agent:write-skill-file', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libWriteSkillFile(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      requireString(a[2], 'relativePath'),
      requireString(a[3], 'content'),
    )
    return { ok: true }
  })
  register('agent:create-skill-entry', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libCreateSkillEntry(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      requireString(a[2], 'relativePath'),
      a[3] === 'directory' ? 'directory' : 'file',
    )
    return { ok: true }
  })
  register('agent:delete-skill-entry', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libDeleteSkillEntry(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      requireString(a[2], 'relativePath'),
    )
    return { ok: true }
  })
  register('agent:rename-skill-entry', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libRenameSkillEntry(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      requireString(a[2], 'fromRelative'),
      requireString(a[3], 'toRelative'),
    )
    return { ok: true }
  })
  register('agent:delete-workspace-skill', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libDeleteWorkspaceSkill(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
    )
    return { ok: true }
  })
  register('agent:toggle-workspace-skill', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libToggleWorkspaceSkill(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'skillSlug'),
      typeof a[2] === 'boolean' ? a[2] : true,
    )
    return { ok: true }
  })

  // ===== MCP 配置读写（纯 fs；运行时验证/启用需在桌面端）=====
  register('agent:get-mcp-config', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libGetWorkspaceMcpConfig(requireString(a[0], 'workspaceSlug'))
  })
  register('agent:save-mcp-config', (args) => {
    const a = Array.isArray(args) ? args : [args]
    const slug = requireString(a[0], 'workspaceSlug')
    const config = a[1]
    if (!config || typeof config !== 'object') throw new Error('save-mcp-config 需要 WorkspaceMcpConfig 对象')
    // Web 形态简化：直接持久化，跳过主进程的 validateAndConditionallyPersistMcp
    // （网络验证 + refresh generation + pending validation 状态）。
    // 用户在 Web 端保存后，需在桌面端重新启用（set-mcp-enabled-and-validate）才能生效。
    libSaveWorkspaceMcpConfig(slug, config as Parameters<typeof libSaveWorkspaceMcpConfig>[1])
    return { ok: true }
  })

  // ===== 工作区记忆文件（agents.md / auto-memory）=====
  register('agent:get-workspace-memory-summary', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libGetWorkspaceMemorySummary(requireString(a[0], 'workspaceSlug'))
  })
  register('agent:read-workspace-agents-md', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libReadWorkspaceAgentsMd(requireString(a[0], 'workspaceSlug'))
  })
  register('agent:write-workspace-agents-md', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libWriteWorkspaceAgentsMd(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'content'),
    )
    return { ok: true }
  })
  register('agent:list-workspace-auto-memory-files', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libListWorkspaceAutoMemoryFiles(requireString(a[0], 'workspaceSlug'))
  })
  register('agent:read-workspace-auto-memory-file', (args) => {
    const a = Array.isArray(args) ? args : [args]
    return libReadWorkspaceAutoMemoryFile(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'filename'),
    )
  })
  register('agent:write-workspace-auto-memory-file', (args) => {
    const a = Array.isArray(args) ? args : [args]
    libWriteWorkspaceAutoMemoryFile(
      requireString(a[0], 'workspaceSlug'),
      requireString(a[1], 'filename'),
      requireString(a[2], 'content'),
    )
    return { ok: true }
  })

  // ===== MCP runtime / 凭据 / OAuth：Web 形态降级 =====
  // 涉及网络测试、runtime 验证、safeStorage 凭据、浏览器回调。
  // 用户需在桌面端操作。
  const mcpRuntimeUnsupported = (channelName: string) => () => {
    throw new PlatformUnsupportedError(
      channelName,
      `Web 形态不支持 ${channelName}；MCP 运行时验证/凭据/OAuth 需桌面端。`,
    )
  }
  register('agent:test-mcp-server', mcpRuntimeUnsupported('agent:test-mcp-server'))
  register('agent:set-mcp-enabled-and-validate', mcpRuntimeUnsupported('agent:set-mcp-enabled-and-validate'))
  register('agent:install-mcp-and-validate', mcpRuntimeUnsupported('agent:install-mcp-and-validate'))
  register('agent:set-builtin-mcp-enabled', mcpRuntimeUnsupported('agent:set-builtin-mcp-enabled'))
  register('agent:save-mcp-api-key', mcpRuntimeUnsupported('agent:save-mcp-api-key'))
  register('agent:delete-mcp-credential', mcpRuntimeUnsupported('agent:delete-mcp-credential'))
  register('agent:start-mcp-oauth', mcpRuntimeUnsupported('agent:start-mcp-oauth'))
  register('agent:refresh-mcp-connections', mcpRuntimeUnsupported('agent:refresh-mcp-connections'))
}
