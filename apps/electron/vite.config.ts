import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

// Web 形态开关：PROMA_WEB_MODE=1 时在 renderer 启用 platform-ipc 的 web bridge。
// Electron 形态保持原状（window.electronAPI + window.promaPlatformAPI）。
const isWebMode = process.env.PROMA_WEB_MODE === '1'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __PROMA_WEB_MODE__: JSON.stringify(isWebMode),
  },
  // vite 6 实现细节：define 字段只在 optimizeDeps / build / 自己 transform 时传给 esbuild。
  // TS 文件 transform 走 `vite:esbuild` plugin，它只用 config.esbuild 选项，**不会**自动合并 config.define。
  // 这里把 define 显式 mirror 到 esbuild.define 才能让运行时 TS 文件里的标识符被替换。
  esbuild: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __PROMA_WEB_MODE__: JSON.stringify(isWebMode),
    },
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    // Web 形态产物输出到 resources/web-server/web，随 extraResources 与 server.cjs
    // 一起分发，由 web-server 直接托管；Electron 形态仍是 dist/renderer。
    outDir: isWebMode
      ? resolve(__dirname, 'resources/web-server/web')
      : resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  css: {
    preprocessorMaxWorkers: 0, // 主进程跑 postcss；便于看到 stack trace
  },
  server: {
    // Chromium can resolve localhost to IPv4 while Vite binds only ::1 on macOS.
    // Use the same explicit IPv4 loopback address as Electron's dev windows.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
    // Web 形态下 Vite 把 /api/* 和 /api/pty/* 反代到 web-server
    proxy: isWebMode
      ? {
        '/api': {
          target: 'http://127.0.0.1:5174',
          changeOrigin: false,
          ws: true,
        },
      }
      : undefined,
  },
})
