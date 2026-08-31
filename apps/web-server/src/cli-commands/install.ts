/**
 * install：写入 systemd unit / launchd plist 并触发加载。
 *
 * 不做 Windows（Windows 走 sc.exe，在 commit 3 实现）。
 */

import { homedir } from 'node:os'

import { PATHS } from '../cli-paths'

import { runCommand, writeFileWithBackup } from '../daemon'
import { LAUNCHD_LABEL, renderLaunchdPlist } from '../daemon/launchd'
import { renderLogrotateConfig } from '../daemon/logrotate'
import { renderNewsyslogConfig } from '../daemon/newsyslog'
import { SYSTEMD_UNIT_FILENAME, renderSystemdUnit } from '../daemon/systemd'
import { buildWindowsInstallCommands, buildWindowsInstallPlan, detectElevation } from '../daemon/windows-service'

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

      // logrotate 配置：用户级目录，无需 root
      const logrotate = renderLogrotateConfig({ home: homedir() })
      writeFileWithBackup(PATHS.systemdLogrotate, logrotate)
      notes.push(`已写入 logrotate 配置：${PATHS.systemdLogrotate}`)

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

      // newsyslog 配置：用户级目录
      const newsyslog = renderNewsyslogConfig({ home: homedir() })
      writeFileWithBackup(PATHS.newsyslogConf, newsyslog)
      notes.push(`已写入 newsyslog 配置：${PATHS.newsyslogConf}`)

      return { platform, notes, backupPath: bakPath, commands }
    }
    case 'win32': {
      const plan = buildWindowsInstallPlan({ promaBin: options.promaBin })
      const cmds = buildWindowsInstallCommands(promaBin, plan.serviceName)
      notes.push(...plan.notes)
      const elevated = !options.dryRun && await detectElevation()
      if (options.dryRun || !elevated) {
        notes.push('---\n# 提示：以下 PowerShell 脚本需以管理员身份运行\n---')
        notes.push(plan.powershell)
        if (!options.dryRun && !elevated) {
          notes.push('当前进程未检测到管理员权限；请在管理员 PowerShell 中执行上方脚本。')
        }
      }
      else {
        // 管理员权限下也走 PowerShell -File <tempfile>：
        // sc.exe 的 binPath= / start= 语法空格解析复杂，
        // shell 转义一旦错就静默丢参数，最稳是喂 PS 脚本。
        const fs = await import('node:fs/promises')
        const os = await import('node:os')
        const path = await import('node:path')
        const tempScript = path.join(os.tmpdir(), `proma-web-install-${Date.now()}.ps1`)
        await fs.writeFile(tempScript, plan.powershell, 'utf-8')
        notes.push(`已生成临时脚本：${tempScript}`)
        try {
          await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScript])
          notes.push('Windows 服务注册成功')
        }
        catch (error) {
          notes.push(`PowerShell 执行失败：${(error as Error).message}`)
        }
        finally {
          await fs.unlink(tempScript).catch(() => {})
        }
      }
      return { platform, notes, commands: cmds }
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
