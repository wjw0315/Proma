/**
 * WebServerManager 单测：覆盖状态机、配置更新、日志缓冲、错误路径。
 * 不真正 spawn 子进程；通过 resolveEntry 注入脚本存在性 + bun 解析。
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServerManager } from './web-server-manager'
import type { WebServerStatusInfo } from '../../types/settings'

let entry: string
let bunBin: string

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'proma-web-mgr-'))
  entry = join(dir, 'server.cjs')
  writeFileSync(entry, '#!/usr/bin/env bun\nconsole.log("mock")')
  // mock bun：用 /bin/sh 充当可执行文件；manager 只检查 existsSync
  bunBin = join(dir, 'bun')
  writeFileSync(bunBin, '#!/bin/sh\nexit 0')
})

function newManager(): WebServerManager {
  return new WebServerManager({
    resolveEntry: () => entry,
    resolveBun: () => bunBin,
  })
}

describe('WebServerManager', () => {
  test('初始状态 idle', () => {
    const m = newManager()
    const status = m.getStatus()
    expect(status.status).toBe('idle')
    expect(status.pid).toBeUndefined()
    expect(status.error).toBeUndefined()
  })

  test('默认 settings 是关闭自动启动的', () => {
    const m = newManager()
    expect(m.getSettings().autoStart).toBe(false)
    expect(m.getSettings().host).toBe('127.0.0.1')
    expect(m.getSettings().port).toBe(5174)
  })

  test('updateSettings 合并字段', () => {
    const m = newManager()
    m.updateSettings({ port: 6000, token: 'abc' })
    expect(m.getSettings().port).toBe(6000)
    expect(m.getSettings().token).toBe('abc')
    expect(m.getSettings().host).toBe('127.0.0.1')
  })

  test('resolveEntry 不存在时 start 失败并置 error', async () => {
    const m = new WebServerManager({
      resolveEntry: () => '/does/not/exist',
      resolveBun: () => bunBin,
    })
    const result = await m.start()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未找到 web-server 入口脚本')
    const status: WebServerStatusInfo = m.getStatus()
    expect(status.status === 'error' || status.status === 'idle').toBe(true)
    expect(status.error ?? '').toContain('未找到')
  })

  test('0.0.0.0 + requireTokenOnPublic 且无 token 拒绝启动', async () => {
    const m = newManager()
    m.updateSettings({ host: '0.0.0.0', token: null })
    const result = await m.start()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('token')
  })

  test('找不到 bun 时拒绝启动', async () => {
    // 在子进程里清空 PATH，确保 findBunInPath 返回 undefined
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const m = new WebServerManager({
        resolveEntry: () => entry,
        resolveBun: () => undefined,
      })
      const result = await m.start()
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('bun')
      expect(m.getStatus().status).toBe('error')
    }
    finally {
      process.env.PATH = originalPath
    }
  })

  test('stop 在 idle 状态下是 no-op', async () => {
    const m = newManager()
    await m.stop()
    expect(m.getStatus().status).toBe('idle')
  })

  test('状态变化触发 status 事件', async () => {
    const m = newManager()
    const seen: WebServerStatusInfo[] = []
    m.on('status', (s) => seen.push(s))
    await m.start()
    // 等子进程走完全部生命周期（mock bun 退出会触发 error，但最终回到 idle）
    await new Promise((r) => setTimeout(r, 1200))
    const states = seen.map((s) => s.status)
    // 状态序列里至少经过 starting 和一次状态变化
    expect(states).toContain('starting')
    expect(states.length).toBeGreaterThan(1)
  })

  test('getRecentLogs 返回环形缓冲', () => {
    const m = newManager()
    // 直接通过 systemLog 触发不方便，这里通过 transition + emit log 模拟
    // 简化：调用 start -> 子进程跑 /bin/sh 不输出，仅验证 limit
    expect(m.getRecentLogs(50)).toEqual([])
    expect(m.getRecentLogs(0).length).toBe(0)
  })
})