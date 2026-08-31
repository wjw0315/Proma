#!/usr/bin/env bun
/**
 * proma-web CLI：独立管理 web-server 子进程。
 *
 * 用法：
 *   proma-web start [--fg] [--entry=path]
 *   proma-web stop
 *   proma-web status
 *   proma-web restart [--fg]
 *   proma-web install        # Linux systemd / macOS launchd / Windows sc.exe
 *   proma-web uninstall
 *   proma-web logs [-n N] [-f]
 *
 * 与设置面板共用 ~/.proma/settings.json 里的 webServer 字段。
 *
 * 设计：
 * - start：fork 当前进程自身（同一 Bun 运行时加载 src/index.ts），
 *   把 PID 写到 ~/.proma/web-server.pid，便于 stop/restart 找到。
 *   日志写到 ~/.proma/logs/web-server.{out,err}.log；旧位置 ~/.proma/web-server.log
 *   会在首次启动时迁移到 logs/web-server.legacy.log。
 * - fg：前台运行；systemd / launchd / sc.exe 都通过 --fg 启动，让 CLI 是单一事实来源。
 * - status：通过 /health 检查可达性 + 读 PID 文件。
 */

import { PATHS } from './cli-paths'
import { isAlive, readPid } from './cli-commands/pid'
import { resolveEntry } from './cli-commands/entry'
import { runInstall } from './cli-commands/install'
import { parseLogsArgs, runLogs } from './cli-commands/logs'
import { runRestart } from './cli-commands/restart'
import { readSettings } from './cli-commands/settings'
import { runStart } from './cli-commands/start'
import { runStatus } from './cli-commands/status'
import { runStop } from './cli-commands/stop'
import { runUninstall } from './cli-commands/uninstall'

interface ParsedArgs {
  positional: string[]
  options: Map<string, string | true>
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  const options = new Map<string, string | true>()
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=')
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      options.set(key, value)
    }
    else if (arg.startsWith('--')) {
      options.set(arg.slice(2), true)
    }
    else {
      positional.push(arg)
    }
  }
  return { positional, options }
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.log('用法：proma-web <start [--fg] [--entry=path] | stop | status | restart | install | uninstall | logs [-n N] [-f]>')
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const [cmd] = parsed.positional

  switch (cmd) {
    case 'start': {
      const settings = readSettings()
      const existing = readPid()
      if (existing && isAlive(existing)) {
        // eslint-disable-next-line no-console
        console.log(`[proma-web] 已在运行（pid=${existing}）`)
        return
      }
      const entry = resolveEntry(typeof parsed.options.get('entry') === 'string'
        ? (parsed.options.get('entry') as string)
        : PATHS.entry)
      runStart(settings, {
        fg: parsed.options.has('fg'),
        entry,
      })
      return
    }
    case 'stop':
      runStop()
      return
    case 'restart': {
      const settings = readSettings()
      const entry = resolveEntry(typeof parsed.options.get('entry') === 'string'
        ? (parsed.options.get('entry') as string)
        : PATHS.entry)
      runRestart(settings, {
        fg: parsed.options.has('fg'),
        entry,
      })
      return
    }
    case 'status':
      await runStatus()
      return
    case 'install': {
      const dryRun = parsed.options.has('dry-run')
      const binOverride = typeof parsed.options.get('bin') === 'string'
        ? (parsed.options.get('bin') as string)
        : undefined
      const result = await runInstall({ dryRun, promaBin: binOverride })
      for (const note of result.notes) {
        // eslint-disable-next-line no-console
        console.log(note)
      }
      return
    }
    case 'uninstall': {
      const dryRun = parsed.options.has('dry-run')
      const result = await runUninstall({ dryRun })
      for (const note of result.notes) {
        // eslint-disable-next-line no-console
        console.log(note)
      }
      return
    }
    case 'logs': {
      const opts = parseLogsArgs(process.argv.slice(3))
      if (!opts.follow) {
        await runLogs({ n: opts.n, follow: false })
        return
      }
      // follow 模式：绑 SIGINT 让 Ctrl+C 干净退出
      const ac = new AbortController()
      process.once('SIGINT', () => ac.abort())
      await runLogs({ n: opts.n, follow: true, signal: ac.signal })
      return
    }
    default:
      usage()
      process.exit(2)
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[proma-web] 错误：', error)
  process.exit(1)
})
