#!/usr/bin/env bash
# 启动 web 形态开发模式：vite + web-server + electronmon
# 现阶段 Web 形态与 Electron renderer 共享源代码；renderer 跑在浏览器里，通过
# window.promaPlatformAPI 与 web-server 通信。
#
# 使用：
#   bash apps/web-server/dev-web.sh
#
# 浏览器访问：
#   http://127.0.0.1:5173

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 1. 启动 web-server
PROMA_WEB_PORT=5174 bun run --hot apps/web-server/src/index.ts &
SERVER_PID=$!

# 2. 启动 Vite dev
PROMA_WEB_MODE=1 bunx vite --config apps/electron/vite.config.ts --port 5173

# 关闭 web-server
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT