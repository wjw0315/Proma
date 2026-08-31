/**
 * 把 apps/web-server/src 打包成单文件 CJS 脚本，供 Electron 内嵌 spawn 使用。
 * 产物路径：apps/electron/resources/web-server/server.cjs
 *
 * 设计：
 * - 单文件 self-contained，运行时只依赖 node_modules（node-pty 等 native）
 * - 不打包 node-pty 等 native 模块（external，由 Electron 的 node_modules 提供）
 * - 入口脚本可以被 Bun 直接执行（生成 #!/usr/bin/env bun shebang）
 */

import { build } from 'esbuild'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const APPS_ELECTRON = join(__filename, '..', '..')
const REPO_ROOT = join(APPS_ELECTRON, '..', '..')
const SRC_ENTRY = join(REPO_ROOT, 'apps', 'web-server', 'src', 'index.ts')
const OUT_DIR = join(APPS_ELECTRON, 'resources', 'web-server')
const OUT_FILE = join(OUT_DIR, 'server.cjs')

async function main(): Promise<void> {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  // 用无导出的临时入口包一层：src/index.ts 的 `export { app }` 会在 CJS 主模块下
  // 触发 Bun 的「默认导出 serve 配置」启发式，导致启动后二次 Bun.serve 崩溃。
  const tmpDir = mkdtempSync('proma-web-server-entry-')
  const shimEntry = join(tmpDir, 'entry.ts')
  writeFileSync(shimEntry, `import ${JSON.stringify(SRC_ENTRY.replace(/\.ts$/, ''))}\n`)

  await build({
    entryPoints: [shimEntry],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // 关键：node-pty 等 native 模块不进 bundle，由运行时 require 解析；
    // bun:sqlite 由 Bun 运行时提供（server.cjs 以 bun 执行），同样保持 external。
    // 注意：@proma/* 等纯 JS 依赖必须打进 bundle，否则打包后的 app 内
    // app.asar.unpacked/node_modules 缺少这些包，spawn 时报 Cannot find module。
    external: ['node-pty', 'bun:sqlite'],
    banner: {
      // 让产物可以被 `bun <file>` 直接执行
      js: '#!/usr/bin/env bun',
    },
    logLevel: 'info',
  })
  rmSync(tmpDir, { recursive: true, force: true })

  // 让脚本可执行
  chmodSync(OUT_FILE, 0o755)

  // 同时生成 package.json 供 asarUnpack 解析
  const pkgPath = join(OUT_DIR, 'package.json')
  writeFileSync(pkgPath, JSON.stringify({
    name: '@proma/web-server-runtime',
    version: '0.0.0',
    description: 'Inlined web-server runtime for Electron embedded mode',
    private: true,
  }, null, 2))

  console.log(`[build-web-server] wrote ${OUT_FILE}`)
}

main().catch((err) => {
  console.error('[build-web-server] failed', err)
  process.exit(1)
})