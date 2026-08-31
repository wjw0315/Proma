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