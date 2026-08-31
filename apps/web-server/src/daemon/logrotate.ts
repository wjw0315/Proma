/**
 * logrotate 配置：Linux 用户级配置（无需 root）。
 *
 * copytruncate：适配 proma-web 始终持有 fd 的现实（systemd / launchd 启动的进程
 * 不会主动 reopen stdout/stderr；copytruncate 用 truncate+recreate 让 logrotate 能切文件）。
 *
 * sharedscripts + postrotate：rotate 后用 systemctl reload-or-try-restart 触发 reopen
 * （若 unit 未运行则 no-op）。
 */

export interface LogrotateOptions {
  home: string
  /** systemd unit 文件名；rotate 后尝试 reload 它 */
  unitName?: string
}

export function renderLogrotateConfig(options: LogrotateOptions): string {
  const { home, unitName = 'proma-web.service' } = options
  return `# proma-web 日志轮转配置
# 用户级配置路径：${home}/.config/logrotate.d/proma-web
# 触发：logrotate 默认由 cron.daily 每日执行；或手动 logrotate -f <file>

${home}/.proma/logs/web-server.out.log
${home}/.proma/logs/web-server.err.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  sharedscripts
  postrotate
    systemctl --user reload-or-try-restart ${unitName} >/dev/null 2>&1 || true
  endscript
}
`
}
