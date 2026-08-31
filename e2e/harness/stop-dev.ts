#!/usr/bin/env bun
/**
 * 清理 e2e/.dev-pids.json 里残留的 dev 进程。
 * 通常不需要单独调用——Playwright 的 webServer 字段会自动管理。
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PID_FILE = join(__dirname, '..', '.dev-pids.json')

interface PidRecord {
  webServer: number
  vite: number
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
    console.log(`[stop] 已发 ${signal} 给 pid=${pid}`)
  }
  catch (err) {
    console.warn(`[stop] pid=${pid} 清理失败：${(err as Error).message}`)
  }
}

function main(): void {
  if (!existsSync(PID_FILE)) {
    console.log('[stop] 未找到 PID 文件，无需清理')
    return
  }
  const raw = JSON.parse(readFileSync(PID_FILE, 'utf-8')) as PidRecord
  kill(raw.webServer, 'SIGTERM')
  kill(raw.vite, 'SIGTERM')
  // 给 2s 让进程响应；之后 SIGKILL
  setTimeout(() => {
    kill(raw.webServer, 'SIGKILL')
    kill(raw.vite, 'SIGKILL')
    try { unlinkSync(PID_FILE) } catch {}
    console.log('[stop] 清理完成')
    process.exit(0)
  }, 2000)
}

main()
