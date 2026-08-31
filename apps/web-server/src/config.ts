/**
 * 启动配置。所有项都可被同名的 PROMA_WEB_* 环境变量覆盖。
 */

export interface WebServerConfig {
  host: string
  port: number
  token: string | null
  /** 当 host 是 0.0.0.0 时是否强制要求 token */
  requireTokenOnPublic: boolean
  /** 默认 30s */
  requestTimeoutMs: number
  /** SSE idle 超时；默认 60s */
  sseIdleMs: number
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 5174,
  token: null as string | null,
  requireTokenOnPublic: true,
  requestTimeoutMs: 30_000,
  sseIdleMs: 60_000,
}

function readEnv(): Partial<WebServerConfig> {
  const env = process.env
  const out: Partial<WebServerConfig> = {}
  if (env.PROMA_WEB_HOST) out.host = env.PROMA_WEB_HOST
  if (env.PROMA_WEB_PORT) out.port = Number(env.PROMA_WEB_PORT)
  if (env.PROMA_WEB_TOKEN) out.token = env.PROMA_WEB_TOKEN
  if (env.PROMA_WEB_REQUIRE_TOKEN !== undefined) {
    out.requireTokenOnPublic = env.PROMA_WEB_REQUIRE_TOKEN !== '0'
      && env.PROMA_WEB_REQUIRE_TOKEN !== 'false'
  }
  if (env.PROMA_WEB_REQUEST_TIMEOUT_MS) {
    out.requestTimeoutMs = Number(env.PROMA_WEB_REQUEST_TIMEOUT_MS)
  }
  if (env.PROMA_WEB_SSE_IDLE_MS) {
    out.sseIdleMs = Number(env.PROMA_WEB_SSE_IDLE_MS)
  }
  return out
}

export function loadConfig(argv: string[] = process.argv.slice(2)): WebServerConfig {
  const cfg: WebServerConfig = { ...DEFAULTS, ...readEnv(), ...readArgv(argv) }
  if (cfg.host === '0.0.0.0' && cfg.requireTokenOnPublic && !cfg.token) {
    throw new Error(
      'PROMA_WEB_HOST=0.0.0.0 需要同时设置 PROMA_WEB_TOKEN；这是安全约束。\n'
      + '本地访问请保持默认 127.0.0.1；公网自托管务必配合反向代理与 HTTPS。',
    )
  }
  if (cfg.port <= 0 || cfg.port > 65535 || Number.isNaN(cfg.port)) {
    throw new Error(`PROMA_WEB_PORT 非法：${cfg.port}`)
  }
  return cfg
}

function readArgv(argv: string[]): Partial<WebServerConfig> {
  const out: Partial<WebServerConfig> = {}
  for (const arg of argv) {
    if (arg.startsWith('--host=')) {
      const v = arg.slice('--host='.length).trim()
      if (v) out.host = v
    }
    else if (arg.startsWith('--port=')) {
      const v = Number(arg.slice('--port='.length))
      if (Number.isFinite(v)) out.port = v
    }
    else if (arg === '--require-token-on-public') {
      out.requireTokenOnPublic = true
    }
    else if (arg === '--no-require-token-on-public') {
      out.requireTokenOnPublic = false
    }
  }
  return out
}