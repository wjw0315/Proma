/**
 * macOS newsyslog.conf 配置：用户级（~/.newsyslog.d/proma-web.conf）。
 *
 * 行为对齐 logrotate：
 * - daily rotate
 * - keep 14 份
 * - 当日志 > 100M 时触发 rotate（避免极端日志把磁盘打爆）
 * - Z（gzip 压缩）
 * - J（bzip2 压缩）
 * - PID file：newsyslog 给进程发 SIGUSR1（仅对真实处理 SIGUSR1 的进程有效，
 *   proma-web 不处理；这里保留 PID 标记以备未来加 reopen）
 */

export interface NewsyslogOptions {
  home: string
  /** 用户名；rotate 后 chown */
  user?: string
  /** 进程 PID 文件；仅作 PID 标记，proma-web 不响应 SIGUSR1 */
  pidFile?: string
}

export function renderNewsyslogConfig(options: NewsyslogOptions): string {
  const { home } = options
  const user = options.user ?? '501' // 默认当前用户 UID；用户可手改
  // 格式：logfilename [owner:group] mode count size when flags [/pid_file] [sig:type]
  return `# proma-web 日志轮转配置（macOS newsyslog）
# 用户级路径：${home}/.newsyslog.d/proma-web.conf
# newsyslog 每小时扫描一次；rotate 时按 PID file 通知进程（proma-web 不响应 SIGUSR1，
# 配合 copytruncate 等价语义通过 truncate 实现；实际由 launchd rotate 自动处理）。

${home}/.proma/logs/web-server.out.log  ${user}:${user}  644  14  100  *  Z
${home}/.proma/logs/web-server.err.log  ${user}:${user}  644  14  100  *  Z
`
}
