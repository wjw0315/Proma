/**
 * git domain 集成测试。
 *
 * 在 /tmp 下创建真实 git 仓库验证读路径；revert 用受控文件验证写路径。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-git-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>
let repoDir: string

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

const GIT = (args: string, cwd: string) => execSync(`git ${args}`, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({ port: 0, fetch: createApp(config).fetch })
  baseUrl = `http://127.0.0.1:${server.port}`

  // 建一个真实的临时 git 仓库
  repoDir = `/tmp/proma-git-test-repo-${process.pid}`
  rmSync(repoDir, { recursive: true, force: true })
  mkdirSync(repoDir, { recursive: true })
  GIT('init -b main', repoDir)
  writeFileSync(`${repoDir}/a.txt`, 'line1\n')
  GIT('add . && git commit -m init', repoDir)
  // 制造未暂存修改 + 未跟踪文件
  writeFileSync(`${repoDir}/a.txt`, 'line1\nline2-modified\n')
  writeFileSync(`${repoDir}/b-new.txt`, 'new file\n')
})

afterAll(() => {
  server.stop()
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(process.env.PROMA_CONFIG_DIR!, { recursive: true, force: true })
})

describe('web-server git domain', () => {
  test('git:get-repo-status 返回真实仓库状态', async () => {
    const st = await ipc<{ isRepo: boolean; branch: string; hasChanges: boolean }>('git:get-repo-status', [repoDir])
    expect(st.isRepo).toBe(true)
    expect(st.branch).toBe('main')
    expect(st.hasChanges).toBe(true)
  })

  test('git:get-repo-status 非目录返回 null', async () => {
    const st = await ipc<null>('git:get-repo-status', [42])
    expect(st).toBeNull()
  })

  test('git:get-unstaged-changes 检出修改与未跟踪文件', async () => {
    const r = await ipc<{ isGitRepo: boolean; files: { filePath?: string }[]; untrackedFiles: unknown[] }>('git:get-unstaged-changes', [repoDir])
    expect(r.isGitRepo).toBe(true)
    expect(r.files.some((f) => String(f.filePath ?? '').includes('a.txt'))).toBe(true)
    expect(r.untrackedFiles.length).toBeGreaterThanOrEqual(1)
  })

  test('git:get-file-diff 返回 a.txt 的 diff', async () => {
    const diff = await ipc<string>('git:get-file-diff', [{ dirPath: repoDir, filePath: 'a.txt' }])
    expect(diff).toContain('line2-modified')
  })

  test('git:get-diff-contents 返回新旧内容', async () => {
    const contents = await ipc<{ oldContent: string; newContent: string } | null>('git:get-diff-contents', [{ dirPath: repoDir, filePath: 'a.txt' }])
    expect(contents?.newContent).toContain('line2-modified')
    expect(contents?.oldContent).toContain('line1')
  })

  test('git:list-worktrees 至少 1 个（主 worktree）', async () => {
    const wt = await ipc<unknown[]>('git:list-worktrees', [repoDir, 'test-session'])
    expect(wt.length).toBeGreaterThanOrEqual(1)
  })

  test('git:revert-file 还原 a.txt', async () => {
    await ipc('git:revert-file', [{ dirPath: repoDir, filePath: 'a.txt' }])
    // 还原后 a.txt 无 diff
    const diff = await ipc<string>('git:get-file-diff', [{ dirPath: repoDir, filePath: 'a.txt' }])
    expect(diff.trim()).toBe('')
  })

  test('git:invalidate-diff-cache 正常返回', async () => {
    const r = await ipc<{ ok: boolean }>('git:invalidate-diff-cache', [repoDir])
    expect(r.ok).toBe(true)
  })
})
