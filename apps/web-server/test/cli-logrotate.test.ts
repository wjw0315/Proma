/**
 * logrotate / newsyslog 配置模板 + install 集成测试。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpHome: string

beforeEach(() => {
  tmpHome = join(tmpdir(), `proma-logrotate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpHome, { recursive: true })
  process.env.PROMA_WEB_CONFIG_DIR = join(tmpHome, '.proma')
  process.env.PROMA_WEB_LOGS_DIR = join(tmpHome, '.proma', 'logs')
  process.env.PROMA_WEB_PID_FILE = join(tmpHome, '.proma', 'web-server.pid')
  process.env.PROMA_WEB_SETTINGS_FILE = join(tmpHome, '.proma', 'settings.json')
  process.env.PROMA_WEB_LEGACY_LOG = join(tmpHome, '.proma', 'web-server.log')
  process.env.PROMA_WEB_SYSTEMD_UNIT = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
  process.env.PROMA_WEB_LOGROTATE_CONF = join(tmpHome, '.config', 'logrotate.d', 'proma-web')
  process.env.PROMA_WEB_LAUNCHD_PLIST = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
  process.env.PROMA_WEB_NEWSYSLOG_CONF = join(tmpHome, '.newsyslog.d', 'proma-web.conf')
})

afterEach(() => {
  for (const key of [
    'PROMA_WEB_CONFIG_DIR',
    'PROMA_WEB_LOGS_DIR',
    'PROMA_WEB_PID_FILE',
    'PROMA_WEB_SETTINGS_FILE',
    'PROMA_WEB_LEGACY_LOG',
    'PROMA_WEB_SYSTEMD_UNIT',
    'PROMA_WEB_LOGROTATE_CONF',
    'PROMA_WEB_LAUNCHD_PLIST',
    'PROMA_WEB_NEWSYSLOG_CONF',
  ]) delete process.env[key]
  try { rmSync(tmpHome, { recursive: true, force: true }) }
  catch { /* best effort */ }
})

describe('renderLogrotateConfig', () => {
  test('包含 daily / rotate / copytruncate / postrotate', async () => {
    const { renderLogrotateConfig } = await import('../src/daemon/logrotate')
    const cfg = renderLogrotateConfig({ home: '/home/alice' })
    expect(cfg).toContain('daily')
    expect(cfg).toContain('rotate 14')
    expect(cfg).toContain('copytruncate')
    expect(cfg).toContain('/home/alice/.proma/logs/web-server.out.log')
    expect(cfg).toContain('/home/alice/.proma/logs/web-server.err.log')
    expect(cfg).toContain('systemctl --user reload-or-try-restart proma-web.service')
  })

  test('自定义 unitName 写入 postrotate', async () => {
    const { renderLogrotateConfig } = await import('../src/daemon/logrotate')
    const cfg = renderLogrotateConfig({ home: '/home/alice', unitName: 'custom.service' })
    expect(cfg).toContain('systemctl --user reload-or-try-restart custom.service')
    expect(cfg).not.toContain('proma-web.service')
  })
})

describe('renderNewsyslogConfig', () => {
  test('包含两个日志路径 + 100M 阈值 + Z 压缩', async () => {
    const { renderNewsyslogConfig } = await import('../src/daemon/newsyslog')
    const cfg = renderNewsyslogConfig({ home: '/Users/bob' })
    expect(cfg).toContain('/Users/bob/.proma/logs/web-server.out.log')
    expect(cfg).toContain('/Users/bob/.proma/logs/web-server.err.log')
    expect(cfg).toContain('100')
    expect(cfg).toContain('Z')
    expect(cfg).toContain('14')
  })
})

describe('runInstall 写 logrotate / newsyslog', () => {
  test('Linux dry-run：同时写 unit 和 logrotate', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const { runInstall } = await import('../src/cli-commands/install')
    await runInstall({ dryRun: true, promaBin: '/usr/local/bin/proma-web' })
    const unitPath = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
    const lrPath = join(tmpHome, '.config', 'logrotate.d', 'proma-web')
    expect(existsSync(unitPath)).toBe(true)
    expect(existsSync(lrPath)).toBe(true)
    const cfg = readFileSync(lrPath, 'utf-8')
    expect(cfg).toContain('copytruncate')
    expect(cfg).toContain(`${tmpHome}/.proma/logs/web-server.out.log`)
  })

  test('macOS dry-run：同时写 plist 和 newsyslog', async () => {
    if (process.platform !== 'darwin') {
      expect(true).toBe(true)
      return
    }
    const { runInstall } = await import('../src/cli-commands/install')
    await runInstall({ dryRun: true, promaBin: '/usr/local/bin/proma-web' })
    const plistPath = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
    const newsyslogPath = join(tmpHome, '.newsyslog.d', 'proma-web.conf')
    expect(existsSync(plistPath)).toBe(true)
    expect(existsSync(newsyslogPath)).toBe(true)
  })
})

describe('runUninstall 清理 logrotate / newsyslog', () => {
  test('Linux dry-run：logrotate 文件加入 removed', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const lrPath = join(tmpHome, '.config', 'logrotate.d', 'proma-web')
    mkdirSync(join(tmpHome, '.config', 'logrotate.d'), { recursive: true })
    writeFileSync(lrPath, 'cfg')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    const result = await runUninstall({ dryRun: true })
    expect(result.removed).toContain(lrPath)
  })

  test('Linux non-dryRun + logrotate 存在：真删', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const lrPath = join(tmpHome, '.config', 'logrotate.d', 'proma-web')
    mkdirSync(join(tmpHome, '.config', 'logrotate.d'), { recursive: true })
    writeFileSync(lrPath, 'cfg')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    await runUninstall({ dryRun: false })
    expect(existsSync(lrPath)).toBe(false)
  })

  test('macOS dry-run：newsyslog 文件加入 removed', async () => {
    if (process.platform !== 'darwin') {
      expect(true).toBe(true)
      return
    }
    const newsyslogPath = join(tmpHome, '.newsyslog.d', 'proma-web.conf')
    mkdirSync(join(tmpHome, '.newsyslog.d'), { recursive: true })
    writeFileSync(newsyslogPath, 'cfg')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    const result = await runUninstall({ dryRun: true })
    expect(result.removed).toContain(newsyslogPath)
  })
})
