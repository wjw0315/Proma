/**
 * install：写入 systemd unit / launchd plist 并触发加载。
 *
 * 不做 Windows（Windows 走 sc.exe，在 commit 3 实现）。
 */

import { homedir } from 'node:os'

import { PATHS } from '../cli-paths'

import { runCommand, writeFileWithBackup } from '../daemon'
import { LAUNCHD_LABEL, renderLaunchdPlist } from '../daemon/launchd'
import { SYSTEMD_UNIT_FILENAME, renderSystemdUnit } from '../daemon/systemd'

export interface InstallOptions {
  /** proma-web 可执行路径；缺省取当前进程 execPath（即 bun） */
  promaBin?: string
  /** 仅生成文件不触发加载；测试与 dry-run 用 */
  dryRun?: boolean
}

export interface InstallResult {
  platform: 'linux' | 'darwin' | 'win32' | 'unsupported'
  notes: string[]
  backupPath?: string
  /** 实际写到磁盘 / 触发加载的命令；用于单元测试 */
  commands?: string[]
}

export async function runInstall(options: InstallOptions = {}): Promise<InstallResult> {
  const platform = detectPlatform()
  const notes: string[] = []
  const commands: string[] = []

  // 先确保日志目录存在（launchd plist 启动时若目录不存在会失败）
  mkdirLogsDir()

  const promaBin = options.promaBin ?? process.execPath
  const execStart = promaBin

  switch (platform) {
    case 'linux': {
      const unit = renderSystemdUnit({ home: homedir(), execStart })
      const { backedUp } = writeFileWithBackup(PATHS.systemdUnit, unit)
      const bakPath = backedUp ? `${PATHS.systemdUnit}.pre-proma-web.bak` : undefined
      notes.push(`已写入 ${PATHS.systemdUnit}${backedUp ? `（旧文件备份为 ${bakPath}）` : ''}`)
      if (!options.dryRun) {
        await runCommand('systemctl', ['--user', 'daemon-reload'])
        commands.push('systemctl --user daemon-reload')
        // 已存在则先停后启；不存在则直接 enable --now
        try {
          await runCommand('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_FILENAME])
          await runCommand('systemctl', ['--user', 'restart', SYSTEMD_UNIT_FILENAME])
          commands.push(`systemctl --user restart ${SYSTEMD_UNIT_FILENAME}`)
        }
        catch {
          await runCommand('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_FILENAME])
          commands.push(`systemctl --user enable --now ${SYSTEMD_UNIT_FILENAME}`)
        }
        notes.push('systemd --user 已加载；可通过 systemctl --user status proma-web 查看')
      }
      else {
        notes.push('dryRun：未触发 systemctl reload / enable')
      }
      return { platform, notes, backupPath: bakPath, commands }
    }
    case 'darwin': {
      const plist = renderLaunchdPlist({ program: promaBin, home: homedir() })
      const { backedUp } = writeFileWithBackup(PATHS.launchdPlist, plist)
      const bakPath = backedUp ? `${PATHS.launchdPlist}.pre-proma-web.bak` : undefined
      notes.push(`已写入 ${PATHS.launchdPlist}${backedUp ? `（旧文件备份为 ${bakPath}）` : ''}`)
      if (!options.dryRun) {
        // bootout 兜底：原 plist 已 bootstrap 过的话必须先 bootout 再 bootstrap，否则 launchd 报 Already loaded
        const uid = process.getuid?.() ?? 0
        const target = `gui/${uid}/${LAUNCHD_LABEL}`
        try {
          await runCommand('launchctl', ['bootout', target])
          commands.push(`launchctl bootout ${target}`)
        }
        catch {
          // 没加载过，忽略
        }
        await runCommand('launchctl', ['bootstrap', `gui/${uid}`, PATHS.launchdPlist])
        commands.push(`launchctl bootstrap gui/${uid} ${PATHS.launchdPlist}`)
        // kickstart 立即拉起（bootstrap 在某些情况下不会立即启动 RunAtLoad 的进程）
        try {
          await runCommand('launchctl', ['kickstart', '-k', target])
          commands.push(`launchctl kickstart -k ${target}`)
        }
        catch {
          // kickstart 偶尔失败（GUI session 不在），bootstrap 已经处理 RunAtLoad
        }
        notes.push(`launchd 已 bootstrap 到 gui/${uid}；可通过 launchctl print gui/${uid}/${LAUNCHD_LABEL} 查看`)
      }
      else {
        notes.push('dryRun：未触发 launchctl bootstrap / kickstart')
      }
      return { platform, notes, backupPath: bakPath, commands }
    }
    case 'win32': {
      // commit 3 实现
      return {
        platform,
        notes: ['Windows 安装请在管理员 PowerShell 里运行 proma-web install（commit 3 实现）'],
      }
    }
    default:
      return {
        platform: 'unsupported',
        notes: [`当前平台 process.platform="${process.platform}" 不在守护化支持范围内`],
      }
  }
}

function detectPlatform(): 'linux' | 'darwin' | 'win32' {
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return process.platform as 'win32'
}

function mkdirLogsDir(): void {
  // 用 PATHS.logsDir 保证 env 覆盖生效
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(PATHS.logsDir, { recursive: true })
}
