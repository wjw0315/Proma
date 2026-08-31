/**
 * IPC 路由注册中心。
 *
 * 每个 handler 形如：
 *   register('channel:name', async (args, ctx) => result)
 *
 * 不在表内的 channel 一律返回 PLATFORM_UNSUPPORTED。
 *
 * 嵌入模式（Electron spawn）与独立模式均直接复用主进程 lib 的纯 fs 业务函数；
 * 依赖 Electron runtime（safeStorage 等）的 domain 需另行桥接，这里仍保持 stub。
 */

import type { WebServerContext } from './context'
import { PlatformUnsupportedError } from '@proma/platform-ipc'
import { ptyPool } from './pty-pool'
import type { IPty } from './pty-pool'

// —— 复用 Electron 应用内无 Electron 依赖的业务模块 ——
// settings-service 及其依赖链（config-paths / types）只使用 node:fs + 环境变量，
// 可在 Bun 环境直接运行，读写同一个 ~/.proma/settings.json。
import {
  getSettings as getSettingsFromLib,
  updateSettings as updateSettingsFromLib,
} from '../../electron/src/main/lib/settings-service'
import { registerPlanningAutomationDomains } from './domains/planning-automation'

export type IpcHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  ctx: WebServerContext,
) => Promise<TResult> | TResult

const handlers = new Map<string, IpcHandler>()

export function register<TArgs, TResult>(
  channel: string,
  handler: IpcHandler<TArgs, TResult>,
): void {
  if (handlers.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}`)
  }
  handlers.set(channel, handler as IpcHandler)
}

export function isRegistered(channel: string): boolean {
  return handlers.has(channel)
}

export async function dispatch(
  channel: string,
  args: unknown,
  ctx: WebServerContext,
): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new PlatformUnsupportedError(
      channel,
      `通道 ${channel} 未在 web-server 注册，Web 形态暂不支持`,
    )
  }
  return handler(args, ctx)
}

// —— Step 2 占位 handlers ——
register('runtime:get-status', async (_args, _ctx) => {
  return { ok: true, status: 'ready' as const }
})

register('runtime:reinit', async () => {
  return { ok: true }
})

// —— Step 7 最小真实链路：chat 流式 echo（用于 E2E 验证 SSE 路径）——
// 不引入 AI provider；推一条 delta chunk 给前端，验证浏览器端完整 SSE 链路。
register('chat:send-message', async (args, ctx) => {
  // /api/ipc 会把整个 args 字段当作位置参数传入。
  // renderer 侧 web-shim 是 safeRequest(platform, channel, args, placeholder)，
  // args 是 preload 透传的数组；这里我们解构第一个元素。
  const raw = (args ?? {}) as { sessionId?: string; content?: string } | unknown[]
  let sessionId: string | undefined
  let content: string | undefined
  if (Array.isArray(raw)) {
    const first = raw[0] as { sessionId?: string; content?: string } | undefined
    sessionId = first?.sessionId
    content = first?.content
  }
  else {
    sessionId = raw.sessionId
    content = raw.content
  }
  if (!sessionId) throw new Error('chat:send-message 需要 sessionId')
  content = typeof content === 'string' ? content : ''
  // 异步推 SSE chunk：避免阻塞 invoke 返回
  setImmediate(() => {
    try {
      ctx.eventBus.publish(`chat:stream:${sessionId}`, {
        kind: 'delta',
        content: `echo: ${content}`,
        seq: 1,
      })
      // 标记完成
      ctx.eventBus.publish(`chat:stream:${sessionId}`, {
        kind: 'done',
        sessionId,
        ts: Date.now(),
      })
    }
    catch (err) {
      ctx.log('error', 'chat:send-message publish 失败', { message: (err as Error).message })
    }
  })
  return { ok: true, sessionId, accepted: true }
})

// —— Step 4 最小通道占位，供 web-shim.ts 高频调用 ——
// 这些占位返回空结构，避免 Web 形态下崩溃。Step 7 接入真实主进程业务后会被覆盖。

// —— settings domain：接入真实业务（读写 ~/.proma/settings.json）——
// 注意：主进程 settings:update 里的副作用（Feishu blocker / AgentIsland 刷新）
// 属于 Electron 进程内状态，web-server 不重复执行；只负责文件落盘。
register('settings:get', async () => getSettingsFromLib())
register('settings:update', async (args) => {
  // web-shim 把多参压成数组；settings:update 只有一个 Partial<AppSettings> 参数
  const updates = Array.isArray(args) ? args[0] : args
  if (!updates || typeof updates !== 'object') {
    throw new Error('settings:update 需要一个 Partial<AppSettings> 对象')
  }
  return updateSettingsFromLib(updates as Parameters<typeof updateSettingsFromLib>[0])
})
register('channels:list', async () => [])
register('agent:list-workspaces', async () => [])
register('agent:list-active-sessions', async () => [])
register('agent:list-archived-sessions', async () => [])
register('agent:get-workspace-capabilities', async () => ({}))
register('chat:list-conversations', async () => [])
register('scratch-pad:load', async () => null)
// planning / automation domain 由 domains/planning-automation.ts 接入真实业务（往下 register 调用）
register('chat-tool:list', async () => [])
register('git:get-repo-status', async () => null)
register('git:get-unstaged-changes', async () => ({ files: [] }))
register('git:get-file-diff', async () => ({ diff: '' }))
register('git:revert-file', async () => ({ ok: true }))
register('git:get-diff-contents', async () => ({ contents: '' }))
register('git:list-worktrees', async () => [])
register('git:get-worktree-changes', async () => ({ changes: [] }))

// 桌面专属能力：明确抛 PlatformUnsupportedError 让前端降级
register('shell:open-external', async () => {
  throw new PlatformUnsupportedError('shell:open-external', 'Web 形态暂未实现 shell:open-external；可在 UI 层拦截并给出 URL')
})
register('shell:system-open-file', async () => {
  throw new PlatformUnsupportedError('shell:system-open-file', 'Web 形态不支持 system-open-file')
})
register('window:minimize', async () => { throw new PlatformUnsupportedError('window:minimize') })
register('window:maximize', async () => { throw new PlatformUnsupportedError('window:maximize') })
register('window:close', async () => { throw new PlatformUnsupportedError('window:close') })
register('window:is-maximized', async () => false)

// —— PTY（Step 3）——
register('terminal:create', async (args, _ctx) => {
  const a = (args ?? {}) as { terminalId: string; cwd?: string; cols?: number; rows?: number; sessionId?: string; profile?: string }
  if (!a.terminalId) throw new Error('terminal:create 需要 terminalId')
  if (ptyPool.has(a.terminalId)) return { ok: true, terminalId: a.terminalId, reused: true }
  const factory = await loadPtyFactory()
  await ptyPool.create({
    terminalId: a.terminalId,
    cwd: a.cwd ?? process.cwd(),
    cols: a.cols ?? 80,
    rows: a.rows ?? 24,
    env: process.env as Record<string, string>,
  }, factory)
  return { ok: true, terminalId: a.terminalId }
})

register('terminal:input', async (args) => {
  const a = args as { terminalId: string; data: string }
  ptyPool.write(a.terminalId, a.data)
  return { ok: true }
})

register('terminal:resize', async (args) => {
  const a = args as { terminalId: string; cols: number; rows: number }
  ptyPool.resize(a.terminalId, a.cols, a.rows)
  return { ok: true }
})

register('terminal:kill', async (args) => {
  const a = args as { terminalId: string }
  ptyPool.kill(a.terminalId)
  return { ok: true }
})

register('terminal:snapshot', async (args) => {
  const a = args as { terminalId: string }
  return ptyPool.snapshot(a.terminalId) ?? { output: '', seq: 0 }
})

let ptyFactoryPromise: Promise<(opts: Parameters<typeof ptyPool.create>[0]) => IPty> | null = null
async function loadPtyFactory() {
  if (!ptyFactoryPromise) {
    ptyFactoryPromise = (async () => {
      // node-pty 是 native 模块；不在 web-server/package.json 默认依赖里。
      // 若运行时动态 require 失败，明确提示用户安装。
      let mod: typeof import('node-pty') | undefined
      try {
        // @ts-ignore: node-pty 是可选依赖，未在 package.json 中声明
        mod = await import('node-pty')
      }
      catch (error) {
        throw new PlatformUnsupportedError(
          'terminal:*',
          `web-server 需要安装 node-pty 以支持终端：Bun add node-pty（当前错误：${(error as Error).message}）`,
        )
      }
      const spawn = (mod as { spawn?: unknown }).spawn as
        | ((file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => IPty)
        | undefined
      if (!spawn) {
        throw new PlatformUnsupportedError('terminal:*', 'node-pty 没有导出 spawn')
      }
      return (opts: Parameters<typeof ptyPool.create>[0]) => {
        const shell = process.env.SHELL ?? '/bin/zsh'
        return spawn(shell, [], {
          name: 'xterm-256color',
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env: opts.env ?? {},
        })
      }
    })()
  }
  return ptyFactoryPromise
}
// —— planning / automation domain：接主进程 lib 真实业务（SQLite + JSON）——
// 依赖 PROMA_CONFIG_DIR 与 Electron 主进程共享同一份数据目录。
registerPlanningAutomationDomains(register)
