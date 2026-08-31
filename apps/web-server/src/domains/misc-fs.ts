/**
 * 小 domain 批量接入：scratch-pad / user-profile / system-prompt / chat-tool。
 *
 * 全部纯 fs（JSON / Markdown），依赖闭包零 Electron import；
 * 数据与 Electron 主进程落同一份配置文件。
 */

import type { IpcHandler } from '../ipc-router'
import { getScratchPadPath } from '../../../electron/src/main/lib/config-paths'
import {
  getUserProfile as libGetUserProfile,
  updateUserProfile as libUpdateUserProfile,
} from '../../../electron/src/main/lib/user-profile-service'
import {
  getSystemPromptConfig as libGetPromptConfig,
  createSystemPrompt as libCreatePrompt,
  updateSystemPrompt as libUpdatePrompt,
  deleteSystemPrompt as libDeletePrompt,
  updateAppendSetting as libUpdateAppend,
  setDefaultPrompt as libSetDefault,
} from '../../../electron/src/main/lib/system-prompt-manager'
import { getAllToolInfos } from '../../../electron/src/main/lib/chat-tool-registry'
import {
  updateToolState as libUpdateToolState,
  updateToolCredentials as libUpdateToolCreds,
  getToolState,
  getToolCredentials,
  addCustomTool,
  deleteCustomTool,
} from '../../../electron/src/main/lib/chat-tool-config'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`)
  return value
}

/** 注册小 domain 通道（scratch-pad / user-profile / system-prompt / chat-tool）。 */
export function registerMiscDomains(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  // ===== scratch-pad（与主进程 ipc.ts 内联实现对齐：load 返回 ''，save 返回 boolean） =====
  register('scratch-pad:load', async () => {
    const path = getScratchPadPath()
    if (!existsSync(path)) return ''
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return ''
    }
  })
  register('scratch-pad:save', async (args) => {
    const content = arg(args, 0)
    if (typeof content !== 'string') throw new Error('content 必须是字符串')
    try {
      await writeFile(getScratchPadPath(), content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // ===== user-profile =====
  register('user-profile:get', () => libGetUserProfile())
  register('user-profile:update', (args) => {
    const updates = arg(args, 0)
    if (!updates || typeof updates !== 'object') throw new Error('updates 必须是对象')
    return libUpdateUserProfile(updates as Parameters<typeof libUpdateUserProfile>[0])
  })

  // ===== system-prompt =====
  register('system-prompt:get-config', () => libGetPromptConfig())
  register('system-prompt:create', (args) => libCreatePrompt(arg(args, 0) as Parameters<typeof libCreatePrompt>[0]))
  register('system-prompt:update', (args) => {
    const id = requireString(arg(args, 0), 'id')
    const input = arg(args, 1)
    if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
    return libUpdatePrompt(id, input as Parameters<typeof libUpdatePrompt>[1])
  })
  register('system-prompt:delete', (args) => {
    libDeletePrompt(requireString(arg(args, 0), 'id'))
    return { ok: true }
  })
  register('system-prompt:update-append-setting', (args) => {
    const enabled = arg(args, 0)
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是 boolean')
    libUpdateAppend(enabled)
    return { ok: true }
  })
  register('system-prompt:set-default', (args) => {
    const id = arg(args, 0)
    libSetDefault(typeof id === 'string' && id ? id : null)
    return { ok: true }
  })

  // ===== chat-tool（配置读写；test-tool 涉及网络执行由后续按需接） =====
  register('chat-tool:get-all-tools', () => getAllToolInfos())
  register('chat-tool:get-state', (args) => getToolState(requireString(arg(args, 0), 'toolId')))
  register('chat-tool:get-credentials', (args) => getToolCredentials(requireString(arg(args, 0), 'toolId')))
  register('chat-tool:update-state', (args) => {
    const toolId = requireString(arg(args, 0), 'toolId')
    const state = arg(args, 1)
    if (!state || typeof state !== 'object') throw new Error('state 必须是对象')
    libUpdateToolState(toolId, state as Parameters<typeof libUpdateToolState>[1])
    return { ok: true }
  })
  register('chat-tool:update-credentials', (args) => {
    const toolId = requireString(arg(args, 0), 'toolId')
    const creds = arg(args, 1)
    if (!creds || typeof creds !== 'object') throw new Error('credentials 必须是对象')
    libUpdateToolCreds(toolId, creds as Record<string, string>)
    return { ok: true }
  })
  register('chat-tool:create-custom', (args) => {
    const meta = arg(args, 0)
    if (!meta || typeof meta !== 'object') throw new Error('meta 必须是对象')
    addCustomTool(meta as Parameters<typeof addCustomTool>[0])
    return { ok: true }
  })
  register('chat-tool:delete-custom', (args) => {
    deleteCustomTool(requireString(arg(args, 0), 'toolId'))
    return { ok: true }
  })
}
