/**
 * WebServerManager：在 Electron 主进程内嵌运行 apps/web-server 子进程。
 *
 * 设计原则：
 * 1. 子进程是独立的 Bun 脚本，避免污染 Electron 主进程的 Node 运行时
 * 2. 状态机：idle -> starting -> running -> stopping -> idle；出错时 running -> error -> idle
 * 3. 状态/日志通过 EventEmitter 暴露给 IPC 层
 * 4. 跟随 Electron 主进程退出：在 app.on('before-quit') 中优雅停掉
 * 5. 鉴权 token 不写入子进程 argv；从父进程环境变量注入，避免 ps 泄露
 *
 * 子进程命令行：
 *   bun apps/web-server/dist/server.cjs \
 *     --host=127.0.0.1 --port=5174 \
 *     --require-token-on-public
 * 环境变量：
 *   PROMA_WEB_TOKEN=xxx
 *   PROMA_WEB_REQUEST_TIMEOUT_MS=30000
 *   PROMA_WEB_SSE_IDLE_MS=60000
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebServerSettings, WebServerStatus, WebServerStatusInfo, WebServerLogEntry } from '../../types/settings'
import { DEFAULT_WEB_SERVER_SETTINGS } from '../../types/settings'

const MAX_LOG_ENTRIES = 500

interface SpawnResult {
  ok: boolean
  reason?: string
}

export interface WebServerManagerOptions {
  /** 解析 web-server 入口脚本路径；优先解析 Electron extraResources */
  resolveEntry(): string
  /** 解析 bun 可执行文件路径；找不到时回退到 process.env.PATH 里的 bun */
  resolveBun?(): string | undefined
  /** Electron 主进程退出时调用，注入此回调让 manager 收尾 */
  onWillQuit?(cb: () => void): void
}

export class WebServerManager extends EventEmitter {
  private settings: WebServerSettings
  private child: ChildProcess | null = null
  private status: WebServerStatus = 'idle'
  private error: string | undefined
  private startedAt: number | undefined
  private readonly logs: WebServerLogEntry[] = []
  private stoppingPromise: Promise<void> | null = null
  private readonly options: WebServerManagerOptions

  constructor(options: WebServerManagerOptions) {
    super()
    this.setMaxListeners(0)
    this.settings = { ...DEFAULT_WEB_SERVER_SETTINGS }
    this.options = options
    this.options.onWillQuit?.(() => {
      // 同步等待；Electron 关闭前必须把子进程干掉
      this.stopSync()
    })
  }

  getSettings(): WebServerSettings {
    return { ...this.settings }
  }

  updateSettings(next: Partial<WebServerSettings>): WebServerSettings {
    this.settings = { ...this.settings, ...next }
    // 重要：host/port/token/timeout 变更需要重启生效
    // 但不在此处自动重启；由 UI 触发 restart()
    return { ...this.settings }
  }

  getStatus(): WebServerStatusInfo {
    return {
      status: this.status,
      pid: this.child?.pid,
      bindAddress: this.status === 'running'
        ? `${this.settings.host}:${this.settings.port}`
        : undefined,
      error: this.error,
      startedAt: this.startedAt,
      lastChangedAt: Date.now(),
    }
  }

  getRecentLogs(limit = 200): WebServerLogEntry[] {
    if (limit >= this.logs.length) return [...this.logs]
    return this.logs.slice(-limit)
  }

  async start(): Promise<SpawnResult> {
    if (this.status === 'running' || this.status === 'starting') {
      return { ok: false, reason: `当前状态 ${this.status}，无需重复启动` }
    }
    const entry = this.options.resolveEntry()
    if (!existsSync(entry)) {
      const msg = `未找到 web-server 入口脚本：${entry}`
      this.fail(msg)
      return { ok: false, reason: msg }
    }
    if (this.settings.host === '0.0.0.0' && this.settings.requireTokenOnPublic && !this.settings.token) {
      const msg = 'PROMA_WEB_HOST=0.0.0.0 需要先设置 token'
      this.fail(msg)
      return { ok: false, reason: msg }
    }

    const bunBin = this.options.resolveBun?.() ?? findBunInPath()
    if (!bunBin) {
      const msg = '找不到 bun 可执行文件；请安装 Bun 或在 PATH 中加入 bun'
      this.fail(msg)
      return { ok: false, reason: msg }
    }

    this.transition('starting')
    this.systemLog(`spawn ${bunBin} ${entry} --host=${this.settings.host} --port=${this.settings.port}`)

    const args = [
      entry,
      `--host=${this.settings.host}`,
      `--port=${this.settings.port}`,
    ]
    if (this.settings.requireTokenOnPublic) {
      args.push('--require-token-on-public')
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PROMA_WEB_REQUEST_TIMEOUT_MS: String(this.settings.requestTimeoutMs),
      PROMA_WEB_SSE_IDLE_MS: String(this.settings.sseIdleMs),
    }
    // 注入配置目录，让 web-server 子进程读写与主进程同一份 ~/.proma 配置
    // （settings / planning / automation 等纯 fs domain 依赖此路径）
    const { getConfigDir } = await import('./config-paths')
    env.PROMA_CONFIG_DIR = getConfigDir()
    if (this.settings.token) {
      env.PROMA_WEB_TOKEN = this.settings.token
    }

    const spawnOpts: SpawnOptions = {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 与父进程解耦，避免主进程退出把子进程一起带走
      detached: false,
    }

    try {
      this.child = spawn(bunBin, args, spawnOpts)
    }
    catch (error) {
      const msg = `spawn 失败：${(error as Error).message}`
      this.fail(msg)
      return { ok: false, reason: msg }
    }

    this.startedAt = Date.now()
    this.attachStreams(this.child)

    // 短暂后切到 running；真实可用性由 web-server 通过 HTTP /health 自报
    setImmediate(() => {
      if (this.child && this.status === 'starting') {
        this.transition('running')
      }
    })

    this.child.on('exit', (code, signal) => {
      this.handleExit(code, signal)
    })
    this.child.on('error', (error) => {
      this.fail(`子进程错误：${error.message}`)
    })

    return { ok: true }
  }

  async stop(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'starting') return
    if (this.stoppingPromise) return this.stoppingPromise
    this.stoppingPromise = this.doStop()
    return this.stoppingPromise
  }

  async restart(): Promise<SpawnResult> {
    await this.stop()
    return this.start()
  }

  private async doStop(): Promise<void> {
    this.transition('stopping')
    const child = this.child
    if (!child) {
      this.transition('idle')
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 5s 未退出，强制 SIGKILL
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL')
        }
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      }
      catch {
        clearTimeout(timer)
        resolve()
      }
    })
    if (this.status !== 'idle') {
      this.transition('idle')
    }
    this.stoppingPromise = null
  }

  /** 主进程退出前的同步版停止；不做优雅等待 */
  stopSync(): void {
    if (!this.child) return
    try {
      this.child.kill('SIGKILL')
    }
    catch {
      // ignore
    }
    this.child = null
    this.status = 'idle'
  }

  private attachStreams(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendLog('stdout', chunk.toString('utf-8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog('stderr', chunk.toString('utf-8'))
    })
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.status === 'stopping') {
      this.transition('idle')
      return
    }
    const msg = `web-server 子进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`
    this.systemLog(msg)
    if (code !== 0 && code !== null) {
      this.error = msg
      this.transition('error')
      // 1s 后回到 idle，允许 UI 重试
      setTimeout(() => {
        if (this.status === 'error') this.transition('idle')
      }, 1_000)
    }
    else {
      this.transition('idle')
    }
    this.child = null
  }

  private transition(next: WebServerStatus): void {
    if (this.status === next) return
    this.status = next
    if (next !== 'error') this.error = undefined
    this.emit('status', this.getStatus())
  }

  private fail(reason: string): void {
    this.error = reason
    this.appendLog('system', reason)
    this.transition('error')
    // 短暂停留以便 UI 看到 error 状态
    setTimeout(() => {
      if (this.status === 'error') this.transition('idle')
    }, 1_000)
  }

  private appendLog(stream: WebServerLogEntry['stream'], message: string): void {
    // 单帧可能含多行；逐行追加便于 UI 滚动查看
    const lines = message.split(/\r?\n/).filter((l) => l.length > 0)
    for (const line of lines) {
      const entry: WebServerLogEntry = { ts: Date.now(), stream, message: line }
      this.logs.push(entry)
      if (this.logs.length > MAX_LOG_ENTRIES) {
        this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES)
      }
      this.emit('log', entry)
    }
  }

  private systemLog(message: string): void {
    this.appendLog('system', `[manager] ${message}`)
  }
}

function findBunInPath(): string | undefined {
  const path = process.env.PATH ?? process.env.Path ?? process.env.path
  if (!path) return undefined
  const parts = path.split(process.platform === 'win32' ? ';' : ':')
  for (const dir of parts) {
    const bin = join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun')
    if (existsSync(bin)) return bin
  }
  return undefined
}