# Proma Web Server

Proma 主进程业务的 Web 形态承载：HTTP API + SSE + WebSocket，配套 Vite dev 反代让浏览器直接访问 Proma。

## 启动

```bash
# 仅启动 web-server（生产模式：需要先 vite build 并托管静态文件）
bun run apps/web-server/src/index.ts

# 开发模式（Vite + web-server）：浏览器访问 http://127.0.0.1:5173
bash apps/web-server/dev-web.sh
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROMA_WEB_HOST` | `127.0.0.1` | 监听地址；公网自托管可设 `0.0.0.0`，**必须同时设置 `PROMA_WEB_TOKEN`** |
| `PROMA_WEB_PORT` | `5174` | 监听端口 |
| `PROMA_WEB_TOKEN` | 未设 | 鉴权 token；不设=仅 loopback 访问 |
| `PROMA_WEB_REQUIRE_TOKEN` | `1` | `PROMA_WEB_HOST=0.0.0.0` 时是否强制要求 token；设 `0` 可关闭 |
| `PROMA_WEB_REQUEST_TIMEOUT_MS` | `30000` | IPC 单次请求超时 |
| `PROMA_WEB_SSE_IDLE_MS` | `60000` | SSE 心跳最大间隔 |

## 路由

- `GET  /health` 健康检查
- `POST /api/ipc` 单次 request/response（body: `{channel, args}`）
- `GET  /api/events?channel=xxx` SSE 订阅
- `WS   /api/pty/{terminalId}` 终端双向流（PTY；`input / resize / ack / kill` 帧）

## 自托管

### 本机访问

默认配置即可；访问 `http://127.0.0.1:5174/health` 验证。

### 局域网访问

```bash
PROMA_WEB_HOST=0.0.0.0 PROMA_WEB_TOKEN=$(openssl rand -hex 32) bun run apps/web-server/src/index.ts
```

反向代理示例（caddy）：

```
api.proma.example.com {
  reverse_proxy 127.0.0.1:5174
  encode zstd gzip
  # SSE 友好配置：禁用缓冲，超时拉长
  @sse path /api/events
    reverse_proxy 127.0.0.1:5174
}
```

### 开机自启（守护进程）

`proma-web` CLI 提供 `install` / `uninstall` / `logs` 子命令，把手动启动升级为系统服务：

| 平台 | 守护进程 | install 行为 | 日志位置 |
| --- | --- | --- | --- |
| Linux | systemd 用户级 unit | 写入 `~/.config/systemd/user/proma-web.service` + `~/.config/logrotate.d/proma-web`，自动 `daemon-reload` + `enable --now` | `~/.proma/logs/web-server.{out,err}.log` |
| macOS | launchd LaunchAgent | 写入 `~/Library/LaunchAgents/com.proma.web.plist` + `~/.newsyslog.d/proma-web.conf`，自动 `bootstrap gui/$UID` | 同上 |
| Windows | sc.exe 服务 | 以管理员身份运行 PowerShell 执行 `sc.exe create PromaWeb ...`（非管理员权限下 install 会打印脚本，不自动执行） | 同上 |

```bash
# 1. 准备好 settings.json：host / port / token（公网必须配 token）
mkdir -p ~/.proma
echo '{"webServer":{"host":"127.0.0.1","port":5174,"token":null}}' > ~/.proma/settings.json

# 2. 安装（开发态直接用仓库根的 bun 运行）
bun run apps/web-server/src/cli.ts install

# 或：打包成单文件后用 ./proma-web install
bun run --filter @proma/web-server build:cli
./apps/web-server/dist/proma-web install

# 3. 查看状态 / 日志
./proma-web status
./proma-web logs -f            # 持续 tail，Ctrl+C 退出
./proma-web logs -n=500        # 最近 500 行（一次性）

# 4. 卸载
./proma-web uninstall
```

#### Linux 细节

- 需要 `XDG_RUNTIME_DIR` 与用户 dbus session 可用（headless 服务器可能需 `loginctl enable-linger <user>`）。
- 崩溃自动重启：`Restart=on-failure`、`RestartSec=5`。
- logrotate：每日 rotate、保留 14 份、`copytruncate` 适配长持有 fd 的进程。

#### macOS 细节

- `RunAtLoad=true` 保证开机 / 用户登录时启动；异常退出后 5 秒内自动重启。
- newsyslog：按 100M 阈值或每日触发 rotate，保留 14 份，gzip 压缩。

#### Windows 细节

- 需要在**管理员身份**的 PowerShell 里运行 `proma-web install`。
- 非管理员权限下 install 会把 PowerShell 脚本打印到 stdout，复制到管理员 PS 中执行即可。
- 服务名 `PromaWeb`，可通过 `Get-Service PromaWeb` 查看状态。
- 日志路径同 Unix：`%USERPROFILE%\.proma\logs\web-server.{out,err}.log`。

#### 调试

`proma-web install --dry-run`：仅生成配置文件 / 渲染脚本，不触发 systemctl / launchctl / sc.exe；适合 CI 验证模板正确性。

## 安全边界

- 默认仅监听 loopback，无 token 时拒绝非本机连接
- `PROMA_WEB_HOST=0.0.0.0` 强制要求 token，否则启动失败
- token 校验使用常量时间比较
- 不实现多用户/租户/计费；这是"可信网络下本人或小团队使用"的形态
- 不支持公网匿名开放；公网自托管请配合反向代理 + HTTPS + 防火墙

## 桌面专属能力

Web 形态下以下能力会抛 `PlatformUnsupportedError`：

- 托盘菜单
- 应用原生菜单
- macOS EventKit（系统日历/提醒）
- 自动更新
- shell.openPath / openExternal

UI 层使用 `apps/electron/src/renderer/lib/platform/capabilities.ts` 的 `hasCapability()` 判断隐藏或占位。