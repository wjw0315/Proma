/**
 * systemd 用户级 unit 模板与渲染。
 *
 * 用法：renderSystemdUnit({ home, execStart })
 * 输出：可直接写到 ~/.config/systemd/user/proma-web.service 的字符串。
 */

export interface SystemdUnitOptions {
  home: string
  /** 完整可执行命令；install 时填 proma-web 可执行路径。含空格需自带引号 */
  execStart: string
}

export const SYSTEMD_UNIT_FILENAME = 'proma-web.service'

/** 给 systemd ExecStart 用的引号转义；纯路径原样返回，含特殊字符加双引号 */
export function quoteForExecStart(value: string): string {
  if (/^[A-Za-z0-9_\-\/.]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
  const { home, execStart } = options
  return `[Unit]
Description=Proma Web Server
Documentation=https://github.com/proma-ai/Proma
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteForExecStart(execStart)} start --fg
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
StandardOutput=append:${home}/.proma/logs/web-server.out.log
StandardError=append:${home}/.proma/logs/web-server.err.log
Environment=PROMA_WEB_PID_FILE=${home}/.proma/web-server.pid
Environment=PROMA_WEB_LOGS_DIR=${home}/.proma/logs

# 优雅关闭：systemd 先发 SIGTERM，stop 子命令流程有 20s 兜底
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`
}
