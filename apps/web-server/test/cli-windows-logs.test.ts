/**
 * Windows 服务 + logs 子命令测试。
 * Windows 部分仅断言 PowerShell 脚本生成；执行部分跨平台不可达。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpHome: string

beforeEach(() => {
  tmpHome = join(tmpdir(), `proma-win-logs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpHome, { recursive: true })
  process.env.PROMA_WEB_CONFIG_DIR = join(tmpHome, '.proma')
  process.env.PROMA_WEB_LOGS_DIR = join(tmpHome, '.proma', 'logs')
  process.env.PROMA_WEB_PID_FILE = join(tmpHome, '.proma', 'web-server.pid')
  process.env.PROMA_WEB_SETTINGS_FILE = join(tmpHome, '.proma', 'settings.json')
  process.env.PROMA_WEB_LEGACY_LOG = join(tmpHome, '.proma', 'web-server.log')
})

afterEach(() => {
  for (const key of [
    'PROMA_WEB_CONFIG_DIR',
    'PROMA_WEB_LOGS_DIR',
    'PROMA_WEB_PID_FILE',
    'PROMA_WEB_SETTINGS_FILE',
    'PROMA_WEB_LEGACY_LOG',
  ]) delete process.env[key]
  try { rmSync(tmpHome, { recursive: true, force: true }) }
  catch { /* best effort */ }
})

describe('windows-service', () => {
  test('buildWindowsInstallPlan：生成 PowerShell 脚本含 sc.exe 命令', async () => {
    const { buildWindowsInstallPlan } = await import('../src/daemon/windows-service')
    const plan = buildWindowsInstallPlan({ promaBin: 'C:\\Program Files\\Proma\\proma-web.exe' })
    expect(plan.serviceName).toBe('PromaWeb')
    expect(plan.powershell).toContain('sc.exe create PromaWeb binPath=')
    expect(plan.powershell).toContain('start --fg')
    expect(plan.powershell).toContain('DisplayName= "Proma Web Server"')
    expect(plan.powershell).toContain('sc.exe description PromaWeb')
    expect(plan.powershell).toContain('sc.exe failure PromaWeb reset= 5 actions= restart/5000')
    expect(plan.powershell).toContain('sc.exe start PromaWeb')
    // binPath 含空格时必须正确转义
    expect(plan.powershell).toContain('C:\\Program Files\\Proma\\proma-web.exe')
  })

  test('buildWindowsInstallCommands：返回结构化命令数组', async () => {
    const { buildWindowsInstallCommands } = await import('../src/daemon/windows-service')
    const cmds = buildWindowsInstallCommands('C:\\bin\\proma-web.exe', 'PromaWeb')
    expect(cmds).toHaveLength(4)
    expect(cmds[0]).toContain('sc.exe create PromaWeb')
    expect(cmds[0]).toContain('start= auto')
    expect(cmds[3]).toContain('sc.exe start PromaWeb')
  })

  test('buildWindowsUninstallPlan：生成 stop + delete 脚本', async () => {
    const { buildWindowsUninstallPlan } = await import('../src/daemon/windows-service')
    const plan = buildWindowsUninstallPlan()
    expect(plan.serviceName).toBe('PromaWeb')
    expect(plan.powershell).toContain('sc.exe stop PromaWeb')
    expect(plan.powershell).toContain('sc.exe delete PromaWeb')
  })

  test('detectElevation：非 Windows 平台返回 false', async () => {
    const { detectElevation } = await import('../src/daemon/windows-service')
    const elevated = await detectElevation()
    expect(elevated).toBe(false)
  })
})

describe('logs 子命令', () => {
  test('parseLogsArgs 默认 200 行 / 不 follow', async () => {
    const { parseLogsArgs } = await import('../src/cli-commands/logs')
    expect(parseLogsArgs([])).toEqual({ n: 200, follow: false })
  })

  test('parseLogsArgs -n=50 / --follow', async () => {
    const { parseLogsArgs } = await import('../src/cli-commands/logs')
    expect(parseLogsArgs(['-n=50', '--follow'])).toEqual({ n: 50, follow: true })
  })

  test('parseLogsArgs -f', async () => {
    const { parseLogsArgs } = await import('../src/cli-commands/logs')
    expect(parseLogsArgs(['-f', '-n=10'])).toEqual({ n: 10, follow: true })
  })

  test('parseLogsArgs -n=0 视为非法，回退 200', async () => {
    const { parseLogsArgs } = await import('../src/cli-commands/logs')
    expect(parseLogsArgs(['-n=0'])).toEqual({ n: 200, follow: false })
  })

  test('tailLines 不存在的文件返回空数组', async () => {
    const { tailLines } = await import('../src/cli-commands/logs')
    expect(tailLines(join(tmpHome, 'nope.log'), 10)).toEqual([])
  })

  test('tailLines 读最后 N 行', async () => {
    const { tailLines } = await import('../src/cli-commands/logs')
    const file = join(tmpHome, 'web.out.log')
    const lines: string[] = []
    for (let i = 1; i <= 50; i++) lines.push(`line ${i}`)
    writeFileSync(file, lines.join('\n') + '\n')
    const tail = tailLines(file, 5)
    expect(tail).toHaveLength(5)
    expect(tail[0]?.text).toBe('line 46')
    expect(tail[4]?.text).toBe('line 50')
  })

  test('tailLines 处理空文件', async () => {
    const { tailLines } = await import('../src/cli-commands/logs')
    const file = join(tmpHome, 'empty.log')
    writeFileSync(file, '')
    expect(tailLines(file, 10)).toEqual([])
  })

  test('runLogs 默认模式：打印 out + err 最近 N 行', async () => {
    const { runLogs } = await import('../src/cli-commands/logs')
    const logsDir = join(tmpHome, '.proma', 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'web-server.out.log'), 'o1\no2\no3\n')
    writeFileSync(join(logsDir, 'web-server.err.log'), 'e1\ne2\n')
    const captured: string[] = []
    const origLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => captured.push(args.join(' '))
    try {
      await runLogs({ n: 10, follow: false })
    }
    finally {
      // eslint-disable-next-line no-console
      console.log = origLog
    }
    expect(captured.some(s => s.includes('[out] o1'))).toBe(true)
    expect(captured.some(s => s.includes('[out] o3'))).toBe(true)
    expect(captured.some(s => s.includes('[err] e1'))).toBe(true)
    expect(captured.some(s => s.includes('[err] e2'))).toBe(true)
  })

  test('runLogs follow 模式：初始打印历史 + 监听新内容', async () => {
    const { runLogs } = await import('../src/cli-commands/logs')
    const logsDir = join(tmpHome, '.proma', 'logs')
    mkdirSync(logsDir, { recursive: true })
    const outFile = join(logsDir, 'web-server.out.log')
    writeFileSync(outFile, 'initial line\n')

    const captured: string[] = []
    const origLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => captured.push(args.join(' '))

    // 200ms 后追加新内容，再 200ms 后 abort
    const ac = new AbortController()
    setTimeout(() => {
      try {
        const fs = require('node:fs') as typeof import('node:fs')
        fs.appendFileSync(outFile, 'appended line\n')
      }
      catch { /* ignore */ }
    }, 200)
    setTimeout(() => ac.abort(), 800)

    try {
      await runLogs({ n: 10, follow: true, signal: ac.signal })
    }
    finally {
      // eslint-disable-next-line no-console
      console.log = origLog
    }

    expect(captured.some(s => s.includes('[out] initial line'))).toBe(true)
    expect(captured.some(s => s.includes('[out] appended line'))).toBe(true)
  })
})
