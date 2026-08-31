/**
 * 共享：读取 ~/.proma/settings.json → webServer 字段；CLI 与 Electron 设置面板共用。
 * 单独抽出来是为了让 start/stop/status/restart 各自只读一次，避免耦合 cli.ts。
 */

import { existsSync, readFileSync } from 'node:fs'

import { PATHS } from '../cli-paths'

export interface CliSettings {
  host: string
  port: number
  token: string | null
  requireTokenOnPublic: boolean
  requestTimeoutMs: number
  sseIdleMs: number
}

export const DEFAULT_CLI_SETTINGS: CliSettings = {
  host: '127.0.0.1',
  port: 5174,
  token: null,
  requireTokenOnPublic: true,
  requestTimeoutMs: 30_000,
  sseIdleMs: 60_000,
}

export function readSettings(): CliSettings {
  if (!existsSync(PATHS.settingsFile)) return { ...DEFAULT_CLI_SETTINGS }
  try {
    const raw = JSON.parse(readFileSync(PATHS.settingsFile, 'utf-8')) as { webServer?: Partial<CliSettings> }
    return { ...DEFAULT_CLI_SETTINGS, ...(raw.webServer ?? {}) }
  }
  catch {
    return { ...DEFAULT_CLI_SETTINGS }
  }
}
