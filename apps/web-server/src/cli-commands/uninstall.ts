/**
 * uninstall：解除 systemd / launchd 加载并删除配置。
 */

import { existsSync } from 'node:fs'

import { PATHS } from '../cli-paths'

import { removeIfExists, runCommand } from '../daemon'
import { LAUNCHD_LABEL } from '../daemon/launchd'
import { SYSTEMD_UNIT_FILENAME } from '../daemon/systemd'

export interface UninstallOptions {
  dryRun?: boolean
}

export interface UninstallResult {
  platform: 'linux' | 'darwin' | 'win32' | 'unsupported'
  notes: string[]
  removed: string[]
}

export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const notes: string[] = []
  const removed: string[] = []
  const platform = process.platform

  switch (platform) {
    case 'linux': {
      if (!options.dryRun) {
        try {
          await runCommand('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_FILENAME])
          notes.push(`已 systemctl --user disable --now ${SYSTEMD_UNIT_FILENAME}`)
        }
        catch {
          notes.push('systemd 服务未加载；跳过 disable')
        }
        // daemon-reload / reset-failed 在没有 systemd 的机器（如 macOS dev box）会抛错，
        // 但单元文件本身仍可清理；不能阻断删除路径。
        try { await runCommand('systemctl', ['--user', 'daemon-reload']) }
        catch { /* best effort */ }
        try { await runCommand('systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT_FILENAME]) }
        catch { /* best effort */ }
      }
      if (existsSync(PATHS.systemdUnit)) {
        if (!options.dryRun) await removeIfExists(PATHS.systemdUnit)
        removed.push(PATHS.systemdUnit)
      }
      return { platform, notes, removed }
    }
    case 'darwin': {
      if (!options.dryRun) {
        const uid = process.getuid?.() ?? 0
        const target = `gui/${uid}/${LAUNCHD_LABEL}`
        try {
          await runCommand('launchctl', ['bootout', target])
          notes.push(`已 launchctl bootout ${target}`)
        }
        catch {
          notes.push('launchd 服务未加载；跳过 bootout')
        }
      }
      if (existsSync(PATHS.launchdPlist)) {
        if (!options.dryRun) await removeIfExists(PATHS.launchdPlist)
        removed.push(PATHS.launchdPlist)
      }
      // 同时清理 backup 文件
      const bak = `${PATHS.launchdPlist}.pre-proma-web.bak`
      if (existsSync(bak)) {
        if (!options.dryRun) await removeIfExists(bak)
        removed.push(bak)
      }
      return { platform, notes, removed }
    }
    case 'win32': {
      // commit 3 实现
      return {
        platform,
        notes: ['Windows 卸载请以管理员身份运行 proma-web uninstall（commit 3 实现）'],
        removed: [],
      }
    }
    default:
      return {
        platform: 'unsupported',
        notes: [`当前平台 process.platform="${platform}" 不在守护化支持范围内`],
        removed: [],
      }
  }
}
