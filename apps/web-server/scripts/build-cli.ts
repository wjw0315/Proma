#!/usr/bin/env bun
/**
 * 把 @proma/web-server 的 CLI 打成单文件可执行。
 *
 * 用法：
 *   bun run scripts/build-cli.ts            # 当前平台
 *   bun run scripts/build-cli.ts --target linux-x64
 *
 * 产物：
 *   dist/proma-web              (Unix)
 *   dist/proma-web.exe          (Windows)
 *
 * 与 apps/electron/scripts/build-web-server.ts 的区别：
 *   - 后者把 src/index.ts 打成 CJS 嵌入 Electron 资源（给 Electron 主进程内嵌 spawn 用）
 *   - 本脚本把 src/cli.ts 打成 standalone 二进制（给自托管用户直接 ./proma-web 用）
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SRC_ENTRY = join(REPO_ROOT, 'apps', 'web-server', 'src', 'cli.ts')
const OUT_DIR = join(REPO_ROOT, 'apps', 'web-server', 'dist')

interface BuildOptions {
  target?: Bun.Build.Target
}

function parseArgs(argv: string[]): BuildOptions {
  for (const arg of argv) {
    if (arg === '--target=linux-x64') return { target: 'bun-linux-x64' }
    if (arg === '--target=darwin-x64') return { target: 'bun-darwin-x64' }
    if (arg === '--target=darwin-arm64') return { target: 'bun-darwin-arm64' }
    if (arg === '--target=windows-x64') return { target: 'bun-windows-x64' }
  }
  return {}
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(SRC_ENTRY)) {
    console.error(`[build-cli] 入口不存在：${SRC_ENTRY}`)
    process.exit(1)
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const isWin = process.platform === 'win32'
  const outfile = isWin ? 'proma-web.exe' : 'proma-web'

  console.log(`[build-cli] entry=${SRC_ENTRY}`)
  console.log(`[build-cli] outdir=${OUT_DIR}`)
  console.log(`[build-cli] target=${opts.target ?? '当前平台'}`)

  const buildOpts: Parameters<typeof Bun.build>[0] = {
    entrypoints: [SRC_ENTRY],
    outdir: OUT_DIR,
    target: opts.target,
    naming: '[dir]/[name]',
    compile: {
      outfile: join(OUT_DIR, outfile),
    },
  }
  const result = await Bun.build(buildOpts)
  if (!result.success) {
    console.error('[build-cli] failed:')
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`[build-cli] wrote ${join(OUT_DIR, outfile)}`)
}

main().catch((err) => {
  console.error('[build-cli] error:', err)
  process.exit(1)
})
