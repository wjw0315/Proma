/**
 * 守护进程工具：把渲染好的 unit / plist 写到磁盘、触发 systemd / launchd 加载。
 *
 * install 子命令会用到。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 把字符串写到 path；若 path 已存在则备份成 .pre-proma-web.bak（仅一次） */
export function writeFileWithBackup(path: string, content: string): { backedUp: boolean } {
  const parent = dirname(path)
  if (parent) mkdirSync(parent, { recursive: true })
  let backedUp = false
  if (existsSync(path)) {
    renameSync(path, `${path}.pre-proma-web.bak`)
    backedUp = true
  }
  writeFileSync(path, content, 'utf-8')
  return { backedUp }
}

/** 静默删除路径（文件不存在 / 权限不足不抛错） */
export async function removeIfExists(path: string): Promise<void> {
  const fs = await import('node:fs')
  try { await fs.promises.unlink(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** 执行外部命令并捕获 stdout/stderr；抛错时附上命令名方便排查 */
export async function runCommand(
  program: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      env: options.env ?? process.env,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }
  catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number }
    throw new Error(
      `命令 ${program} ${args.join(' ')} 失败：${e.message}`
      + (e.stderr ? `\nstderr: ${e.stderr.trim()}` : '')
      + (e.stdout ? `\nstdout: ${e.stdout.trim()}` : '')
      + (e.code ? `\nexit: ${e.code}` : ''),
    )
  }
}
