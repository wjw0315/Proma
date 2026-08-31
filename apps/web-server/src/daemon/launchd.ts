/**
 * macOS launchd LaunchAgent plist 模板与渲染。
 *
 * RunAtLoad=true：开机 / bootstrap 时立即启动；
 * KeepAlive + SuccessfulExit=false：异常退出自动重启；
 * ThrottleInterval=5：5 秒内最多重启一次，避免崩溃风暴。
 */

export interface LaunchdPlistOptions {
  /** proma-web 可执行文件绝对路径 */
  program: string
  home: string
  /** 进程标签；同时是 plist 文件名（去掉 .plist 后缀） */
  label?: string
}

export const LAUNCHD_LABEL = 'com.proma.web'

export function renderLaunchdPlist(options: LaunchdPlistOptions): string {
  const { program, home } = options
  const label = options.label ?? LAUNCHD_LABEL
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(program)}</string>
    <string>start</string>
    <string>--fg</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>CrashInterval</key>
    <integer>5</integer>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(home)}/.proma/logs/web-server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(home)}/.proma/logs/web-server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROMA_WEB_PID_FILE</key>
    <string>${escapeXml(home)}/.proma/web-server.pid</string>
    <key>PROMA_WEB_LOGS_DIR</key>
    <string>${escapeXml(home)}/.proma/logs</string>
  </dict>
</dict>
</plist>
`
}

/** launchd plist 不支持 XML 实体；安全转义五字符 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
