#!/usr/bin/env bun
/**
 * 启动 E2E 测试需要的两个进程：
 *   1. apps/web-server (端口 5174)
 *   2. vite dev (端口 5173, PROMA_WEB_MODE=1)
 *
 * 等待 web-server /health 返回 200、vite 主页返回 200 后退出。
 * 进程 PID 写入 e2e/.dev-pids.json 供 stop-dev.ts 清理。
 *
 * 设计：
 * - 用 detached 子进程，避免父进程退出把子进程带走
 * - 父进程不退出：保持前台运行直到 SIGTERM/SIGINT
 * - 轮询 /health 而不是依赖 stderr "listening" 行：更稳
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VITE_PORT, WEB_SERVER_PORT, VITE_URL, WEB_SERVER_URL } from './ports'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const PID_FILE = join(__dirname, '..', '.dev-pids.json')
const START_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500

interface PidRecord {
  webServer: number
  vite: number
  startedAt: number
}

let webServer: ChildProcess | null = null
let vite: ChildProcess | null = null

async function waitFor(url: string, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: name === 'web-server' ? 'GET' : 'GET' })
      if (res.status >= 200 && res.status < 500) {
        console.log(`[harness] ${name} 已就绪：${url} (status=${res.status})`)
        return
      }
      lastError = new Error(`${url} status=${res.status}`)
    }
    catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`${name} 在 ${timeoutMs}ms 内未就绪：${url}\n最后一次错误：${(lastError as Error)?.message ?? String(lastError)}`)
}

function writePids(pids: PidRecord): void {
  mkdirSync(dirname(PID_FILE), { recursive: true })
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2))
}

function spawnDetached(
  command: string,
  args: string[],
  env: Record<string, string>,
  name: string,
): ChildProcess {
  console.log(`[harness] spawn ${name}: ${command} ${args.join(' ')}`)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false, // 跟随父进程退出；stop-dev 显式 SIGTERM
    cwd: ROOT,
  })
  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[${name}] ${b.toString('utf-8')}`))
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[${name}] ${b.toString('utf-8')}`))
  child.on('exit', (code, signal) => {
    console.log(`[harness] ${name} 退出：code=${code} signal=${signal}`)
  })
  return child
}

async function main(): Promise<void> {
  const bunBin = process.env.BUN_BIN ?? 'bun'

  // 1. web-server
  if (!existsSync(join(ROOT, 'apps/web-server/src/index.ts'))) {
    throw new Error(`未找到 apps/web-server/src/index.ts；ROOT=${ROOT}`)
  }
  webServer = spawnDetached(
    bunBin,
    ['run', '--hot', 'apps/web-server/src/index.ts'],
    {
      PROMA_WEB_HOST: '127.0.0.1',
      PROMA_WEB_PORT: String(WEB_SERVER_PORT),
      PROMA_WEB_TOKEN: '',
      PROMA_WEB_REQUIRE_TOKEN: '0',
    },
    'web-server',
  )

  // 2. vite dev（使用 E2E 专用 config，含 force-web-mode plugin 修复 vite define bug）
  vite = spawnDetached(
    bunBin,
    ['x', 'vite', '--config', 'e2e/harness/vite.config.ts', '--port', String(VITE_PORT), '--host', '127.0.0.1'],
    {
      PROMA_WEB_MODE: '1',
      PROMA_WEB_PORT: String(WEB_SERVER_PORT),
      PROMA_WEB_HOST: '127.0.0.1',
    },
    'vite',
  )

  writePids({
    webServer: webServer.pid ?? 0,
    vite: vite.pid ?? 0,
    startedAt: Date.now(),
  })

  try {
    await waitFor(`${WEB_SERVER_URL}/health`, 'web-server', START_TIMEOUT_MS)
    await waitFor(VITE_URL, 'vite', START_TIMEOUT_MS)
    console.log('[harness] 两个服务都已就绪；进入保持模式')
    console.log('[harness] 等待 SIGTERM/SIGINT 退出…')

    // 保持父进程存活；Playwright 会通过 webServer.command 模式自动管理生命周期
    // 但我们手动用 start-dev 作为 command 时需要保持前台运行
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        webServer?.kill('SIGTERM')
        vite?.kill('SIGTERM')
        resolve()
      }
      process.on('SIGTERM', cleanup)
      process.on('SIGINT', cleanup)
    })
  }
  finally {
    webServer?.kill('SIGTERM')
    vite?.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error('[harness] 启动失败：', err)
  webServer?.kill('SIGTERM')
  vite?.kill('SIGTERM')
  process.exit(1)
})
