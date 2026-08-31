/**
 * start [--fg]
 *
 * 后台模式：fork 自身 + bun + entry，detached + stdio 写到 logs/{out,err}.log。
 * 前台模式（--fg）：stdio inherit，由 systemd / launchd / sc.exe 接管。
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'

import { logFilePath, PATHS } from '../cli-paths'
import { migrateLegacyLog, writePid } from './pid'

import type { CliSettings } from './settings'

export interface StartOptions {
  /** 前台运行；守护进程场景使用 */
  fg: boolean
  /** 入口路径；缺省由 resolveEntry 决定 */
  entry: string
}

function buildEnv(settings: CliSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROMA_WEB_HOST: settings.host,
    PROMA_WEB_PORT: String(settings.port),
    PROMA_WEB_REQUEST_TIMEOUT_MS: String(settings.requestTimeoutMs),
    PROMA_WEB_SSE_IDLE_MS: String(settings.sseIdleMs),
  }
  if (settings.token) env.PROMA_WEB_TOKEN = settings.token
  return env
}

function buildArgs(settings: CliSettings, entry: string): string[] {
  const args = [
    entry,
    `--host=${settings.host}`,
    `--port=${settings.port}`,
  ]
  if (settings.requireTokenOnPublic) args.push('--require-token-on-public')
  return args
}

export function startForeground(settings: CliSettings, entry: string): void {
  const child = spawn(process.execPath, buildArgs(settings, entry), {
    stdio: 'inherit',
    env: buildEnv(settings),
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

export function startBackground(settings: CliSettings, entry: string): void {
  migrateLegacyLog()
  const outFd = openSync(logFilePath('out'), 'a')
  const errFd = openSync(logFilePath('err'), 'a')
  const child = spawn(process.execPath, buildArgs(settings, entry), {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: buildEnv(settings),
  })
  child.unref()
  const pid = child.pid ?? -1
  writePid(pid)
  // eslint-disable-next-line no-console
  console.log(`[proma-web] 已启动 (pid=${pid})，日志：${PATHS.logsDir}`)
}

export function runStart(settings: CliSettings, options: StartOptions): void {
  if (settings.host === '0.0.0.0' && settings.requireTokenOnPublic && !settings.token) {
    // eslint-disable-next-line no-console
    console.error('[proma-web] host=0.0.0.0 但 token 为空，拒绝启动')
    process.exit(1)
  }
  if (options.fg) {
    startForeground(settings, options.entry)
  }
  else {
    startBackground(settings, options.entry)
  }
}
