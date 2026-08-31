/**
 * git domain：把 web-server IPC 通道接到主进程 lib 真实业务。
 *
 * 依赖链（git-detector / git-diff-service）零 Electron 依赖
 * （windows-env 的 app.isPackaged 已改延迟加载），底层 child_process 调 git。
 *
 * 安全边界：主进程 handler 有 ensurePathAllowed（session/workspace 路径授权）
 * 校验；web-server 场景下浏览器为同机同用户（bearer token 鉴权），
 * 无跨用户越权面，因此只做基本类型校验。若后续 web-server 暴露到
 * 公网，需在此补路径白名单。
 */

import type { IpcHandler } from '../ipc-router'
import { getGitRepoStatus } from '../../../electron/src/main/lib/git-detector'
import {
  getUnstagedChanges as libGetUnstaged,
  getFileDiff as libGetFileDiff,
  getDiffContents as libGetDiffContents,
  getUntrackedContent as libGetUntracked,
  revertFile as libRevertFile,
  listWorktrees as libListWorktrees,
  getWorktreeChanges as libGetWorktreeChanges,
  invalidateGitDiffCache as libInvalidate,
} from '../../../electron/src/main/lib/git-diff-service'

function arg(args: unknown, n: number): unknown {
  return Array.isArray(args) ? args[n] : (n === 0 ? args : undefined)
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** 无效目录时的空结果（与主进程 handler 语义一致）。 */
const EMPTY_UNSTAGED = { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }

/** 注册 git domain 通道。 */
export function registerGitDomain(register: <TArgs, TResult>(channel: string, handler: IpcHandler<TArgs, TResult>) => void): void {
  register('git:get-repo-status', async (args) => {
    const dirPath = optString(arg(args, 0))
    if (!dirPath) return null
    return getGitRepoStatus(dirPath)
  })

  register('git:get-unstaged-changes', async (args) => {
    const dirPath = optString(arg(args, 0))
    if (!dirPath) return EMPTY_UNSTAGED
    const sessionPath = optString(arg(args, 1))
    const workspaceFilesPath = optString(arg(args, 2))
    const rawExtra = arg(args, 3)
    const extraPaths = Array.isArray(rawExtra) ? rawExtra.filter((p): p is string => typeof p === 'string') : undefined
    return libGetUnstaged(dirPath, sessionPath, workspaceFilesPath, extraPaths)
  })

  register('git:get-file-diff', async (args) => {
    const input = arg(args, 0) as { dirPath?: unknown; filePath?: unknown; gitRoot?: unknown } | undefined
    if (!input || typeof input !== 'object' || typeof input.dirPath !== 'string' || typeof input.filePath !== 'string') {
      return ''
    }
    return libGetFileDiff(input.dirPath, input.filePath, optString(input.gitRoot))
  })

  register('git:get-untracked-content', async (args) => {
    const input = arg(args, 0) as { dirPath?: unknown; filePath?: unknown; gitRoot?: unknown } | undefined
    if (!input || typeof input !== 'object' || typeof input.dirPath !== 'string' || typeof input.filePath !== 'string') {
      return ''
    }
    return libGetUntracked(input.dirPath, input.filePath, optString(input.gitRoot))
  })

  register('git:get-diff-contents', async (args) => {
    const input = arg(args, 0) as { dirPath?: unknown; filePath?: unknown; gitRoot?: unknown; baseRef?: unknown } | undefined
    if (!input || typeof input !== 'object' || typeof input.dirPath !== 'string' || typeof input.filePath !== 'string') {
      return null
    }
    return libGetDiffContents(input.dirPath, input.filePath, optString(input.gitRoot), optString(input.baseRef))
  })

  register('git:revert-file', async (args) => {
    const input = arg(args, 0) as { dirPath?: unknown; filePath?: unknown; gitRoot?: unknown } | undefined
    if (!input || typeof input !== 'object' || typeof input.dirPath !== 'string' || typeof input.filePath !== 'string') {
      throw new Error('dirPath 与 filePath 必填')
    }
    await libRevertFile(input.dirPath, input.filePath, optString(input.gitRoot))
    return { ok: true }
  })

  register('git:list-worktrees', async (args) => {
    const repoPath = optString(arg(args, 0))
    if (!repoPath) return []
    return libListWorktrees(repoPath)
  })

  register('git:get-worktree-changes', async (args) => {
    const worktreePath = optString(arg(args, 0))
    const baseBranch = optString(arg(args, 1))
    if (!worktreePath || !baseBranch) return EMPTY_UNSTAGED
    return libGetWorktreeChanges(worktreePath, baseBranch)
  })

  register('git:invalidate-diff-cache', (args) => {
    libInvalidate(optString(arg(args, 0)))
    return { ok: true }
  })
}
