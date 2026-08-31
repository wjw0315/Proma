/**
 * proma-web CLI 行为测试：路径迁移、PID 读写、start --fg、status、stop。
 *
 * 测试隔离：用临时 HOME 目录，避开真实的 ~/.proma。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个 case 用独立 tmp 目录
let tmpHome: string

beforeEach(() => {
  tmpHome = join(tmpdir(), `proma-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpHome, { recursive: true })
  process.env.PROMA_WEB_CONFIG_DIR = tmpHome
  process.env.PROMA_WEB_LOGS_DIR = join(tmpHome, 'logs')
  process.env.PROMA_WEB_PID_FILE = join(tmpHome, 'web-server.pid')
  process.env.PROMA_WEB_SETTINGS_FILE = join(tmpHome, 'settings.json')
  process.env.PROMA_WEB_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
  process.env.PROMA_WEB_LEGACY_LOG = join(tmpHome, 'web-server.log')
})

afterEach(() => {
  delete process.env.PROMA_WEB_CONFIG_DIR
  delete process.env.PROMA_WEB_LOGS_DIR
  delete process.env.PROMA_WEB_PID_FILE
  delete process.env.PROMA_WEB_SETTINGS_FILE
  delete process.env.PROMA_WEB_ENTRY
  delete process.env.PROMA_WEB_LEGACY_LOG
  // 尽力清理；不抛错
  try { rmSync(tmpHome, { recursive: true, force: true }) }
  catch { /* 进程未退出，目录可能被占用 */ }
})

describe('migrateLegacyLog', () => {
  test('旧日志存在且未迁移：rename 到 logs/web-server.legacy.log', async () => {
    const legacyPath = join(tmpHome, 'web-server.log')
    writeFileSync(legacyPath, 'old content\n')
    const { migrateLegacyLog, LOG_FILE_NAMES } = await import('../src/cli-commands/pid')
    migrateLegacyLog()
    expect(existsSync(legacyPath)).toBe(false)
    const dst = join(tmpHome, 'logs', LOG_FILE_NAMES.legacy)
    expect(existsSync(dst)).toBe(true)
    expect(readFileSync(dst, 'utf-8')).toBe('old content\n')
  })

  test('无旧日志：迁移是 no-op，不抛错', async () => {
    const { migrateLegacyLog, LOG_FILE_NAMES } = await import('../src/cli-commands/pid')
    expect(() => migrateLegacyLog()).not.toThrow()
    // logs 目录应被创建
    expect(existsSync(join(tmpHome, 'logs'))).toBe(true)
    // 但 legacy 文件不存在
    expect(existsSync(join(tmpHome, 'logs', LOG_FILE_NAMES.legacy))).toBe(false)
  })

  test('旧日志已迁移过：不再重复迁移（dst 已存在）', async () => {
    const legacyPath = join(tmpHome, 'web-server.log')
    const dst = join(tmpHome, 'logs', 'web-server.legacy.log')
    writeFileSync(legacyPath, 'newer content\n')
    mkdirSync(join(tmpHome, 'logs'), { recursive: true })
    writeFileSync(dst, 'older migrated content\n')
    const { migrateLegacyLog } = await import('../src/cli-commands/pid')
    migrateLegacyLog()
    // 旧文件还在（说明没再迁移）
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(dst, 'utf-8')).toBe('older migrated content\n')
  })
})

describe('PID 读写', () => {
  test('writePid / readPid / clearPid 闭环', async () => {
    const { writePid, readPid, clearPid } = await import('../src/cli-commands/pid')
    expect(readPid()).toBeNull()
    writePid(12345)
    expect(readPid()).toBe(12345)
    clearPid()
    expect(readPid()).toBeNull()
  })

  test('PID 文件非数字：readPid 返回 null', async () => {
    const { writePid, readPid } = await import('../src/cli-commands/pid')
    writePid(99999)
    // 覆盖为非数字
    const fs = await import('node:fs')
    fs.writeFileSync(join(tmpHome, 'web-server.pid'), 'not-a-number')
    expect(readPid()).toBeNull()
  })

  test('isAlive：当前进程应被识别为存活', async () => {
    const { isAlive } = await import('../src/cli-commands/pid')
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(999_999_999)).toBe(false)
  })
})

describe('resolveEntry', () => {
  test('--entry 指向 dev 路径：返回该路径', async () => {
    const { resolveEntry } = await import('../src/cli-commands/entry')
    const entry = resolveEntry(join(import.meta.dir, '..', 'src', 'index.ts'))
    expect(entry.endsWith('index.ts')).toBe(true)
  })

  test('--entry 指向不存在路径：抛错', async () => {
    const { resolveEntry } = await import('../src/cli-commands/entry')
    expect(() => resolveEntry('/nonexistent/path/server.cjs')).toThrow(/--entry/)
  })

  test('不传 --entry：在仓库开发态能找到 src/index.ts', async () => {
    const { resolveEntry } = await import('../src/cli-commands/entry')
    const entry = resolveEntry()
    expect(entry.endsWith('index.ts')).toBe(true)
  })
})

describe('CLI dispatch', () => {
  test('无参数：打印 usage 并退出码 2', async () => {
    const { spawn } = await import('node:child_process')
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts')
    const proc = spawn(process.execPath, [cliPath], {
      env: { ...process.env, PROMA_WEB_CONFIG_DIR: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const code = await new Promise<number>((resolve) => proc.on('exit', (c) => resolve(c ?? -1)))
    expect(code).toBe(2)
  })

  test('status（未运行）：打印 PID=无、HTTP 不可达', async () => {
    const { spawnSync } = await import('node:child_process')
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts')
    const result = spawnSync(process.execPath, [cliPath, 'status'], {
      env: { ...process.env, PROMA_WEB_CONFIG_DIR: tmpHome, PROMA_WEB_LOGS_DIR: join(tmpHome, 'logs') },
      encoding: 'utf-8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PID 文件：无')
    expect(result.stdout).toContain('HTTP /health: 不可达')
  })

  test('stop 无 PID 文件：打印"未运行"，退出码 0', async () => {
    const { spawnSync } = await import('node:child_process')
    const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts')
    const result = spawnSync(process.execPath, [cliPath, 'stop'], {
      env: { ...process.env, PROMA_WEB_CONFIG_DIR: tmpHome },
      encoding: 'utf-8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('未运行')
  })
})
