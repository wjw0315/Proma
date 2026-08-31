/**
 * proma-web CLI 路径常量。
 *
 * 所有路径都允许通过同名的 PROMA_WEB_* 环境变量覆盖，方便守护进程 / 容器化部署。
 *
 * 关键设计：路径在 getter 里**每次重新读取 env**，避免测试隔离时被模块顶层缓存污染。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export const PATHS = {
  get configDir() { return envOr('PROMA_WEB_CONFIG_DIR', join(homedir(), '.proma')) },
  get logsDir() { return envOr('PROMA_WEB_LOGS_DIR', join(homedir(), '.proma', 'logs')) },
  get pidFile() { return envOr('PROMA_WEB_PID_FILE', join(homedir(), '.proma', 'web-server.pid')) },
  get settingsFile() { return envOr('PROMA_WEB_SETTINGS_FILE', join(homedir(), '.proma', 'settings.json')) },
  /** 旧日志位置；仅迁移时引用一次；可通过 PROMA_WEB_LEGACY_LOG 覆盖（测试与迁移脚本用） */
  get legacyLogFile() {
    return envOr('PROMA_WEB_LEGACY_LOG', join(PATHS.configDir, 'web-server.log'))
  },

  /** web-server 入口；--entry 可覆盖 */
  get entry() { return process.env.PROMA_WEB_ENTRY },

  /** systemd 用户级 unit；仅 Linux 使用 */
  get systemdUnit() {
    return envOr('PROMA_WEB_SYSTEMD_UNIT', join(homedir(), '.config', 'systemd', 'user', 'proma-web.service'))
  },
  get systemdLogrotate() {
    return envOr('PROMA_WEB_LOGROTATE_CONF', join(homedir(), '.config', 'logrotate.d', 'proma-web'))
  },

  /** launchd LaunchAgent；仅 macOS 使用 */
  get launchdPlist() {
    return envOr('PROMA_WEB_LAUNCHD_PLIST', join(homedir(), 'Library', 'LaunchAgents', 'com.proma.web.plist'))
  },
  get newsyslogConf() {
    return envOr('PROMA_WEB_NEWSYSLOG_CONF', join(homedir(), '.newsyslog.d', 'proma-web.conf'))
  },

  /** Windows 服务名；仅 Windows 使用 */
  get windowsServiceName() {
    return envOr('PROMA_WEB_WINDOWS_SERVICE_NAME', 'PromaWeb')
  },
} as const

/** 标准日志文件名；install/uninstall 会用到 */
export const LOG_FILES = {
  out: 'web-server.out.log',
  err: 'web-server.err.log',
  legacy: 'web-server.legacy.log',
} as const

export function logFilePath(kind: keyof typeof LOG_FILES): string {
  return join(PATHS.logsDir, LOG_FILES[kind])
}
