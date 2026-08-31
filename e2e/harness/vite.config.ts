/**
 * E2E 测试专用的 vite 配置。
 *
 * 与 apps/electron/vite.config.ts 的差异：
 * - 强制 PROMA_WEB_MODE 走 web 形态（__PROMA_WEB_MODE__ = true）
 * - 加 /api 反代到 web-server 5174
 * - 保留与项目一致的 esbuild.define mirror（详见 apps/electron/vite.config.ts 注释）
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJ_ROOT = resolve(__dirname, '..', '..')
const WEB_SERVER_DIR = resolve(PROJ_ROOT, 'apps/electron')
const PORT = 5173

const __APP_VERSION__ = JSON.stringify('0.0.0-e2e')
const __PROMA_WEB_MODE__ = JSON.stringify(true)

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__, __PROMA_WEB_MODE__ },
  esbuild: {
    define: { __APP_VERSION__, __PROMA_WEB_MODE__ },
  },
  root: resolve(WEB_SERVER_DIR, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@/types': resolve(WEB_SERVER_DIR, 'src/types'),
      '@': resolve(WEB_SERVER_DIR, 'src/renderer'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    open: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: false,
        ws: true,
      },
    },
  },
})
