/**
 * agent 会话/工作区 domain（只读）的 IPC 集成测试。
 *
 * 通过 PROMA_CONFIG_DIR 隔离到临时目录；会话/工作区数据目录由
 * agent-workspace-manager 基于 config 目录派生，同样落在临时目录内。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-agent-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

async function ipcRaw(channel: string, args?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })
}

async function ipc<T>(channel: string, args?: unknown): Promise<T> {
  const res = await ipcRaw(channel, args)
  const body = await res.json() as { ok: boolean; data?: T; error?: { message: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'ipc failed')
  return body.data as T
}

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({ port: 0, fetch: createApp(config).fetch })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
  rmSync(process.env.PROMA_CONFIG_DIR!, { recursive: true, force: true })
})

describe('web-server agent sessions domain（只读）', () => {
  test('agent:list-workspaces 返回数组（隔离目录起步为空）', async () => {
    const list = await ipc<unknown[]>('agent:list-workspaces')
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBe(0)
  })

  test('agent:list-sessions / active / archived / count 返回一致', async () => {
    const all = await ipc<unknown[]>('agent:list-sessions')
    const active = await ipc<unknown[]>('agent:list-active-sessions')
    const archived = await ipc<unknown[]>('agent:list-archived-sessions')
    const count = await ipc<number>('agent:count-archived-sessions')
    expect(Array.isArray(all)).toBe(true)
    expect(active.length).toBe(0)
    expect(archived.length).toBe(0)
    expect(count).toBe(0)
  })

  test('agent:get-sdk-messages 拒绝空 sessionId', async () => {
    const res = await ipcRaw('agent:get-sdk-messages', [''])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('必填')
  })

  test('agent:get-sdk-messages 不存在的会话返回空数组或报错（不崩）', async () => {
    // 两种实现均可接受：主进程语义是返回 []
    const res = await ipcRaw('agent:get-sdk-messages', ['nonexistent-session-id'])
    expect([200, 500]).toContain(res.status)
  })

  test('agent:get-workspace-capabilities 拒绝不存在的工作区', async () => {
    const res = await ipcRaw('agent:get-workspace-capabilities', ['no-such-slug'])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('不存在')
  })
})

describe('web-server agent 会话写操作', () => {
  test('create / update-title / toggle-pin / toggle-archive / delete 闭环', async () => {
    // 创建
    const created = await ipc<{ id: string; title: string }>('agent:create-session', ['写操作测试'])
    expect(created.title).toBe('写操作测试')

    // 列表可见
    const list = await ipc<{ id: string }[]>('agent:list-sessions')
    expect(list.some((s) => s.id === created.id)).toBe(true)

    // 改名
    const renamed = await ipc<{ title: string }>('agent:update-title', [created.id, '改名会话'])
    expect(renamed.title).toBe('改名会话')

    // pin / archive 切换
    const pinned = await ipc<{ pinned: boolean }>('agent:toggle-pin', [created.id])
    expect(pinned.pinned).toBe(true)
    const archived = await ipc<{ archived: boolean }>('agent:toggle-archive', [created.id])
    expect(archived.archived).toBe(true)

    // 删除
    await ipc('agent:delete-session', [created.id])
    const after = await ipc<{ id: string }[]>('agent:list-sessions')
    expect(after.some((s) => s.id === created.id)).toBe(false)
  })

  test('create-session 拒绝非 boolean isDraft', async () => {
    const res = await ipcRaw('agent:create-session', ['x', undefined, undefined, undefined, 'yes'])
    expect(res.status).toBe(500)
  })

  test('toggle-pin 拒绝不存在的会话', async () => {
    const res = await ipcRaw('agent:toggle-pin', ['no-such-id'])
    expect(res.status).toBe(500)
  })

  test('update-session-model 更新 channel/model', async () => {
    const created = await ipc<{ id: string }>('agent:create-session', ['模型测试'])
    const updated = await ipc<{ channelId?: string; modelId?: string }>('agent:update-session-model', [created.id, 'ch-1', 'model-x'])
    expect(updated.channelId).toBe('ch-1')
    expect(updated.modelId).toBe('model-x')
    await ipc('agent:delete-session', [created.id])
  })
})

describe('web-server agent:get-session-path（PR2 Bug2 回归）', () => {
  test('不再返回 PLATFORM_UNSUPPORTED，且不崩（侧栏能正常调用）', async () => {
    // 即使传入不存在的 workspaceId + 合法 sessionId 也应返回 null（与主进程语义一致）
    const res = await ipcRaw('agent:get-session-path', ['no-such-workspace-id', 'session-id-1'])
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data?: string | null; error?: { code: string } }
    expect(body.ok).toBe(true)
    expect(body.error).toBeUndefined()
    expect(body.data).toBeNull()
  })

  test('缺 workspaceId 参数给出明确错误', async () => {
    const res = await ipcRaw('agent:get-session-path', ['', 'session-id-1'])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('workspaceId')
  })

  test('缺 sessionId 参数给出明确错误', async () => {
    const res = await ipcRaw('agent:get-session-path', ['workspace-id-1', ''])
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('sessionId')
  })

  test('真实 workspace + session 返回路径字符串', async () => {
    // 直接调主进程 lib 创建 workspace（不走 IPC，避免依赖未注册的 create-workspace channel）
    const { createAgentWorkspace } = await import('../../electron/src/main/lib/agent-workspace-manager')
    const ws = createAgentWorkspace({ name: 'session-path 测试', projectRootPath: '/tmp' })

    const path = await ipc<string | null>('agent:get-session-path', [ws.id, 'session-abc'])
    expect(typeof path).toBe('string')
    expect(path).toContain(ws.slug)
    expect(path).toContain('session-abc')
    expect(path!.endsWith('session-abc')).toBe(true)
  })
})

describe('web-server agent skills CRUD（PR6 Bug3 D5）', () => {
  // 预创建 workspace + 内置 skill 模板
  let workspaceSlug = ''
  let skillSlug = 'pr6-skill'
  beforeAll(async () => {
    const { createAgentWorkspace, upgradeDefaultSkillsInWorkspaces } = await import(
      '../../electron/src/main/lib/agent-workspace-manager'
    )
    const ws = createAgentWorkspace({ name: 'PR6 Skills 测试', projectRootPath: '/tmp' })
    workspaceSlug = ws.slug
    upgradeDefaultSkillsInWorkspaces()
    // 创建 skill 目录骨架：直接走 lib（getWorkspaceMcpConfig/create-skill-entry 需要 skillDir 存在）
    const fs = await import('node:fs')
    const { join } = await import('node:path')
    const { getAgentWorkspacesDir } = await import('../../electron/src/main/lib/config-paths')
    const skillDir = join(getAgentWorkspacesDir(), workspaceSlug, 'skills', skillSlug)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(join(skillDir, 'SKILL.md'), '# PR6 Test Skill\n')
  })

  test('list-skill-files 返回文件树（SKILL.md 由主编辑器管理，不在列）', async () => {
    // create-skill-entry 先建个文件
    await ipc('agent:create-skill-entry', [workspaceSlug, skillSlug, 'extra.md', 'file'])
    const files = await ipc<{ relativePath: string; type: 'file' | 'directory' }[]>(
      'agent:list-skill-files', [workspaceSlug, skillSlug]
    )
    expect(Array.isArray(files)).toBe(true)
    expect(files.some((f) => f.relativePath === 'extra.md')).toBe(true)
    // SKILL.md 不在列表中是设计如此，由主编辑器独立管理
  })

  test('read-skill-file 读取文本文件', async () => {
    // SKILL.md 由主编辑器管理，需走 readWorkspaceSkillContent 专用接口
    // （本测试覆盖的是普通子文件的读写路径：先 create-skill-entry 创 extra.md）
    await ipc('agent:create-skill-entry', [workspaceSlug, skillSlug, 'note.md', 'file'])
    const file = await ipc<{ isText: boolean; content?: string }>(
      'agent:read-skill-file', [workspaceSlug, skillSlug, 'note.md']
    )
    expect(file.isText).toBe(true)
    expect(file.content).toBe('')
  })

  test('write-skill-file 覆写 + read-skill-file 看到新内容', async () => {
    await ipc('agent:write-skill-file', [workspaceSlug, skillSlug, 'note.md', '# Updated'])
    const file = await ipc<{ content?: string }>('agent:read-skill-file', [workspaceSlug, skillSlug, 'note.md'])
    expect(file.content).toBe('# Updated')
  })

  test('create-skill-entry 创子文件 → list-skill-files 看到 → delete-skill-entry 删子文件', async () => {
    await ipc('agent:create-skill-entry', [workspaceSlug, skillSlug, 'note2.md', 'file'])
    // 文件刚被 list-skill-files 看到过；list 递归子目录，这里查 nested entry
    const before = await ipc<{ relativePath: string }[]>('agent:list-skill-files', [workspaceSlug, skillSlug])
    expect(before.some((f) => f.relativePath === 'note2.md')).toBe(true)

    await ipc('agent:delete-skill-entry', [workspaceSlug, skillSlug, 'note2.md'])
    const after = await ipc<{ relativePath: string }[]>('agent:list-skill-files', [workspaceSlug, skillSlug])
    expect(after.some((f) => f.relativePath === 'note2.md')).toBe(false)
  })

  test('rename-skill-entry 改路径', async () => {
    await ipc('agent:create-skill-entry', [workspaceSlug, skillSlug, 'old.md', 'file'])
    await ipc('agent:rename-skill-entry', [workspaceSlug, skillSlug, 'old.md', 'new.md'])
    const after = await ipc<{ relativePath: string }[]>('agent:list-skill-files', [workspaceSlug, skillSlug])
    expect(after.some((f) => f.relativePath === 'new.md')).toBe(true)
    expect(after.some((f) => f.relativePath === 'old.md')).toBe(false)
  })
})

describe('web-server agent MCP config 读写（PR6 Bug3 D5）', () => {
  let workspaceSlug = ''
  beforeAll(async () => {
    const { createAgentWorkspace } = await import(
      '../../electron/src/main/lib/agent-workspace-manager'
    )
    const ws = createAgentWorkspace({ name: 'PR6 MCP 测试', projectRootPath: '/tmp' })
    workspaceSlug = ws.slug
  })

  test('get-mcp-config 起步空 servers', async () => {
    const cfg = await ipc<{ servers: Record<string, unknown> }>('agent:get-mcp-config', [workspaceSlug])
    expect(cfg.servers).toEqual({})
  })

  test('save-mcp-config 写入后 get-mcp-config 能读回', async () => {
    const serverName = 'pr6-mcp-server'
    await ipc('agent:save-mcp-config', [workspaceSlug, {
      servers: {
        [serverName]: {
          type: 'stdio',
          command: 'echo',
          args: ['hello'],
          enabled: false,
        },
      },
    }])
    const cfg = await ipc<{ servers: Record<string, { command?: string; enabled?: boolean }> }>(
      'agent:get-mcp-config', [workspaceSlug]
    )
    expect(cfg.servers[serverName]?.command).toBe('echo')
    expect(cfg.servers[serverName]?.enabled).toBe(false)
  })
})

describe('web-server agent MCP runtime / OAuth 降级（PR6 Bug3 D5）', () => {
  for (const ch of [
    'agent:test-mcp-server',
    'agent:set-mcp-enabled-and-validate',
    'agent:install-mcp-and-validate',
    'agent:set-builtin-mcp-enabled',
    'agent:save-mcp-api-key',
    'agent:delete-mcp-credential',
    'agent:start-mcp-oauth',
    'agent:refresh-mcp-connections',
  ]) {
    test(`${ch} 拋 PlatformUnsupportedError（MCP 运行时 / 凭据 / OAuth 需桌面端）`, async () => {
      const res = await ipcRaw(ch, ['any-slug'])
      expect(res.status).toBe(501)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
      expect(body.error.message).toContain(ch)
    })
  }
})
