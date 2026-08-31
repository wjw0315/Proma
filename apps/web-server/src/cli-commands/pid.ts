/**
 * 共享：PID 文件读写 + 进程存活探测 + 日志迁移。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { LOG_FILES, PATHS, logFilePath } from '../cli-paths'

export function writePid(pid: number): void {
  mkdirSync(PATHS.configDir, { recursive: true })
  writeFileSync(PATHS.pidFile, String(pid))
}

export function clearPid(): void {
  try { unlinkSync(PATHS.pidFile) }
  catch { /* 文件不存在 / 没权限，忽略 */ }
}

export function readPid(): number | null {
  if (!existsSync(PATHS.pidFile)) return null
  const raw = readFileSync(PATHS.pidFile, 'utf-8').trim()
  const pid = Number(raw)
  if (!Number.isFinite(pid)) return null
  return pid
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/**
 * 启动前调用一次：把旧的 ~/.proma/web-server.log 迁移到 logs/web-server.legacy.log。
 * 幂等：迁移过就不会再迁。
 */
export function migrateLegacyLog(): void {
  mkdirSync(PATHS.logsDir, { recursive: true })
  const legacyDst = logFilePath('legacy')
  if (existsSync(PATHS.legacyLogFile) && !existsSync(legacyDst)) {
    try {
      renameSync(PATHS.legacyLogFile, legacyDst)
      // eslint-disable-next-line no-console
      console.warn(`[proma-web] 已迁移旧日志到 ${legacyDst}`)
    }
    catch (error) {
      // 迁移失败不阻断启动；让新日志写到新位置即可
      // eslint-disable-next-line no-console
      console.warn(`[proma-web] 旧日志迁移失败：${(error as Error).message}`)
    }
  }
}

/** 给守护进程 / 测试用：标记已迁移过（迁移文件存在即视为完成） */
export function isLegacyMigrated(): boolean {
  return !existsSync(PATHS.legacyLogFile) || existsSync(logFilePath('legacy'))
}

/** 仅供测试用：暴露日志文件名常量 */
export const LOG_FILE_NAMES = LOG_FILES
