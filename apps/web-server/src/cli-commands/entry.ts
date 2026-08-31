/**
 * 共享：解析 web-server 入口文件路径。
 *
 * 优先级：
 *   1. 显式 --entry <path>（命令行或 PROMA_WEB_ENTRY 环境变量）
 *   2. 当前模块所在目录下的 index.ts（仓库开发态）
 *   3. 跨平台约定的 production 路径
 *      - macOS: /usr/local/share/proma-web/server.cjs
 *      - Linux: /usr/lib/proma-web/server.cjs
 *      - Windows: %ProgramFiles%\\Proma\\web-server\\server.cjs
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 定位 web-server 包根目录。
 * 既能在仓库开发态（apps/web-server/src/）下找到入口，
 * 也能在打包后（dist/proma-web 与 src/index.ts 平级）下找到入口。
 */
function packageSrcDir(): string {
  // cli-commands/entry.ts 跑在 apps/web-server/src/cli-commands/
  // 包根的 src 目录是 import.meta.dir 的 ../src
  const here = import.meta.dir
  // 兜底：开发态
  const fromCliCommands = join(here, '..')
  if (existsSync(join(fromCliCommands, 'index.ts'))) return fromCliCommands
  // 兜底：打包后（cli.ts 与 src/ 平级）
  return dirname(here)
}

export function resolveEntry(override?: string): string {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`--entry 指定的入口不存在：${override}`)
    }
    return override
  }

  // 开发态：包根 src/index.ts
  const devEntry = join(packageSrcDir(), 'index.ts')
  if (existsSync(devEntry)) return devEntry

  // production：约定路径
  const candidates = productionEntryCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `未找到 web-server 入口。尝试过：\n  - ${devEntry}\n  - ${candidates.join('\n  - ')}\n`
    + '可用 --entry <path> 显式指定，或设置 PROMA_WEB_ENTRY。',
  )
}

function productionEntryCandidates(): string[] {
  const list: string[] = []
  if (process.platform === 'darwin') {
    list.push('/usr/local/share/proma-web/server.cjs')
    list.push('/opt/homebrew/share/proma-web/server.cjs')
  }
  else if (process.platform === 'linux') {
    list.push('/usr/lib/proma-web/server.cjs')
    list.push('/usr/local/lib/proma-web/server.cjs')
  }
  else if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    list.push(`${pf}\\Proma\\web-server\\server.cjs`)
  }
  return list
}
