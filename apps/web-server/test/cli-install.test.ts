/**
 * proma-web install / uninstall 测试。
 *
 * 用临时 HOME 隔离；dry-run 模式断言渲染产物和触发命令序列。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpHome: string

beforeEach(() => {
  tmpHome = join(tmpdir(), `proma-install-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpHome, { recursive: true })
  // 所有 PROMA_WEB_* 路径都重定向到 tmpHome
  process.env.PROMA_WEB_CONFIG_DIR = join(tmpHome, '.proma')
  process.env.PROMA_WEB_LOGS_DIR = join(tmpHome, '.proma', 'logs')
  process.env.PROMA_WEB_PID_FILE = join(tmpHome, '.proma', 'web-server.pid')
  process.env.PROMA_WEB_SETTINGS_FILE = join(tmpHome, '.proma', 'settings.json')
  process.env.PROMA_WEB_LEGACY_LOG = join(tmpHome, '.proma', 'web-server.log')
  // 让 systemdUnit / launchdPlist 也指向 tmpHome
  process.env.PROMA_WEB_SYSTEMD_UNIT = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
  process.env.PROMA_WEB_LOGROTATE_CONF = join(tmpHome, '.config', 'logrotate.d', 'proma-web')
  process.env.PROMA_WEB_LAUNCHD_PLIST = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
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
  ]) delete process.env[key]
  try { rmSync(tmpHome, { recursive: true, force: true }) }
  catch { /* best effort */ }
})

describe('renderSystemdUnit', () => {
  test('输出包含关键字段', async () => {
    const { renderSystemdUnit } = await import('../src/daemon/systemd')
    const unit = renderSystemdUnit({ home: '/home/alice', execStart: '/usr/local/bin/proma-web' })
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('Description=Proma Web Server')
    expect(unit).toContain('ExecStart=/usr/local/bin/proma-web start --fg')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=5')
    expect(unit).toContain('StandardOutput=append:/home/alice/.proma/logs/web-server.out.log')
    expect(unit).toContain('StandardError=append:/home/alice/.proma/logs/web-server.err.log')
    expect(unit).toContain('PROMA_WEB_PID_FILE=/home/alice/.proma/web-server.pid')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('execStart 含空格：被自动加引号', async () => {
    const { renderSystemdUnit } = await import('../src/daemon/systemd')
    const unit = renderSystemdUnit({ home: '/home/alice', execStart: '/some path/binary' })
    expect(unit).toContain('ExecStart="/some path/binary" start --fg')
  })
})

describe('renderLaunchdPlist', () => {
  test('输出包含关键字段且 XML 转义', async () => {
    const { renderLaunchdPlist } = await import('../src/daemon/launchd')
    const xml = renderLaunchdPlist({ program: '/usr/local/bin/proma-web', home: '/Users/bob' })
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain('<string>com.proma.web</string>')
    expect(xml).toContain('<string>/usr/local/bin/proma-web</string>')
    expect(xml).toContain('<string>start</string>')
    expect(xml).toContain('<string>--fg</string>')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<true/>')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<key>SuccessfulExit</key>')
    expect(xml).toContain('<false/>')
    expect(xml).toContain('<key>ThrottleInterval</key>')
    expect(xml).toContain('<integer>5</integer>')
    expect(xml).toContain('/Users/bob/.proma/logs/web-server.out.log')
    expect(xml).toContain('PROMA_WEB_PID_FILE')
  })

  test('program 含 & 时被 XML 转义', async () => {
    const { renderLaunchdPlist } = await import('../src/daemon/launchd')
    const xml = renderLaunchdPlist({ program: '/bin/foo&bar', home: '/Users/bob' })
    expect(xml).toContain('/bin/foo&amp;bar')
    expect(xml).not.toContain('foo&bar</string>')
  })

  test('自定义 label', async () => {
    const { renderLaunchdPlist } = await import('../src/daemon/launchd')
    const xml = renderLaunchdPlist({ program: '/bin/proma-web', home: '/Users/bob', label: 'com.test.custom' })
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain('<string>com.test.custom</string>')
  })
})

describe('daemon.writeFileWithBackup', () => {
  test('首次写入：不备份，直接写文件', async () => {
    const { writeFileWithBackup } = await import('../src/daemon')
    const path = join(tmpHome, 'unit.service')
    const { backedUp } = writeFileWithBackup(path, 'content')
    expect(backedUp).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('content')
  })

  test('已有内容：备份为 .pre-proma-web.bak 再写', async () => {
    const { writeFileWithBackup } = await import('../src/daemon')
    const path = join(tmpHome, 'unit.service')
    writeFileSync(path, 'old content')
    const { backedUp } = writeFileWithBackup(path, 'new content')
    expect(backedUp).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('new content')
    expect(readFileSync(`${path}.pre-proma-web.bak`, 'utf-8')).toBe('old content')
  })

  test('父目录不存在：自动创建', async () => {
    const { writeFileWithBackup } = await import('../src/daemon')
    const path = join(tmpHome, 'deep', 'nested', 'unit.service')
    writeFileWithBackup(path, 'x')
    expect(existsSync(path)).toBe(true)
  })
})

describe('runInstall', () => {
  test('Linux dry-run：写 unit 文件，记录 systemctl 命令预期', async () => {
    if (process.platform !== 'linux') {
      // 跳过：runInstall 按 process.platform 分支，在非 Linux 上不会写 systemd unit
      expect(true).toBe(true)
      return
    }
    process.env.PROMA_WEB_SYSTEMD_UNIT = join(tmpHome, 'unit', 'proma-web.service')
    const { runInstall } = await import('../src/cli-commands/install')
    const result = await runInstall({ dryRun: true, promaBin: '/usr/local/bin/proma-web' })
    expect(result.platform).toBe('linux')
    const unitPath = join(tmpHome, 'unit', 'proma-web.service')
    expect(existsSync(unitPath)).toBe(true)
    const content = readFileSync(unitPath, 'utf-8')
    expect(content).toContain('ExecStart=/usr/local/bin/proma-web start --fg')
    expect(content).toContain('Restart=on-failure')
    expect(result.commands ?? []).toContain('systemctl --user daemon-reload')
  })

  test('Linux 已存在 unit：备份 .pre-proma-web.bak', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const unitPath = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
    mkdirSync(join(tmpHome, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, 'old content')
    const { runInstall } = await import('../src/cli-commands/install')
    await runInstall({ dryRun: true, promaBin: '/usr/local/bin/proma-web' })
    expect(existsSync(`${unitPath}.pre-proma-web.bak`)).toBe(true)
    expect(readFileSync(`${unitPath}.pre-proma-web.bak`, 'utf-8')).toBe('old content')
    expect(readFileSync(unitPath, 'utf-8')).not.toBe('old content')
  })

  test('macOS dry-run：写 plist 文件', async () => {
    // 临时把 platform 切换成 darwin 不可能；只能测在 darwin 上跑
    if (process.platform !== 'darwin') {
      // 在非 darwin 平台 skip；但仍然渲染验证
      const { renderLaunchdPlist } = await import('../src/daemon/launchd')
      const xml = renderLaunchdPlist({ program: '/usr/local/bin/proma-web', home: tmpHome })
      expect(xml).toContain('<plist')
      expect(xml).toContain('com.proma.web')
      return
    }
    process.env.PROMA_WEB_LAUNCHD_PLIST = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
    const { runInstall } = await import('../src/cli-commands/install')
    const result = await runInstall({ dryRun: true, promaBin: '/usr/local/bin/proma-web' })
    expect(result.platform).toBe('darwin')
    const plistPath = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
    expect(existsSync(plistPath)).toBe(true)
    const xml = readFileSync(plistPath, 'utf-8')
    expect(xml).toContain('<key>ProgramArguments</key>')
    expect(xml).toContain('/usr/local/bin/proma-web')
    expect(xml).toContain('<key>RunAtLoad</key>')
  })

  test('Windows：返回 win32 + 占位提示', async () => {
    // 通过 Object.defineProperty 临时改 platform 不优雅；改用直接测 win32 分支的方式不可行
    // 这里覆盖 install.ts 对 win32 的返回契约：当 platform 是 win32 时返回 win32 + 占位 notes
    if (process.platform === 'win32') {
      const { runInstall } = await import('../src/cli-commands/install')
      const result = await runInstall({ dryRun: true })
      expect(result.platform).toBe('win32')
      expect(result.notes.some(n => n.includes('commit 3'))).toBe(true)
    }
    else {
      // 静默通过：不在 win32 机器上无法直接走分支
      expect(true).toBe(true)
    }
  })
})

describe('runUninstall', () => {
  test('Linux dry-run：unit 不存在 → notes 提示，跳过 disable', async () => {
    process.env.PROMA_WEB_SYSTEMD_UNIT = join(tmpHome, 'unit', 'proma-web.service')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    if (process.platform !== 'linux') {
      // 跳过：runUninstall 按 process.platform 分支，macOS 上不会走 linux 路径
      expect(true).toBe(true)
      return
    }
    const result = await runUninstall({ dryRun: true })
    expect(result.platform).toBe('linux')
    expect(result.notes.some(n => n.includes('未加载') || n.includes('跳过 disable'))).toBe(true)
  })

  test('Linux：unit 存在 → 移除文件', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const unitPath = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
    mkdirSync(join(tmpHome, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, 'unit content')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    const result = await runUninstall({ dryRun: true })
    expect(result.removed).toContain(unitPath)
    expect(existsSync(unitPath)).toBe(true) // dryRun 不真删
  })

  test('Linux：non-dryRun 且 unit 存在 → 真删文件', async () => {
    if (process.platform !== 'linux') {
      expect(true).toBe(true)
      return
    }
    const unitPath = join(tmpHome, '.config', 'systemd', 'user', 'proma-web.service')
    mkdirSync(join(tmpHome, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, 'unit content')
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    await runUninstall({ dryRun: false })
    expect(existsSync(unitPath)).toBe(false)
  })

  test('macOS dry-run：plist 存在 → 标记为 removed（dryRun 不真删）', async () => {
    if (process.platform !== 'darwin') {
      expect(true).toBe(true)
      return
    }
    const plistPath = join(tmpHome, 'Library', 'LaunchAgents', 'com.proma.web.plist')
    mkdirSync(join(tmpHome, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath, '<plist/>')
    process.env.PROMA_WEB_LAUNCHD_PLIST = plistPath
    const { runUninstall } = await import('../src/cli-commands/uninstall')
    const result = await runUninstall({ dryRun: true })
    expect(result.removed).toContain(plistPath)
  })
})
