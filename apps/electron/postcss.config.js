import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default {
  plugins: {
    // 显式指定 tailwind.config.js 路径；tailwindcss 插件默认从 process.cwd() 找，
    // 但 vite 启动时 cwd 是仓库根，仓库根没有 tailwind.config.js；不指定会导致
    // tailwind 拿到空 config，content 缺失、border-border class not found 等问题。
    tailwindcss: { config: __dirname + '/tailwind.config.js' },
    autoprefixer: {},
  },
}
