/**
 * 解析 web-server 子进程的入口路径与 bun 可执行文件路径。
 *
 * 开发模式（apps/electron dev 脚本启动）：
 *   直接读仓库内的 apps/web-server/src/index.ts，用仓库根的 bun 运行
 *
 * 生产模式（electron-builder 产物）：
 *   从 process.resourcesPath/web-server/server.cjs 读取（electron-builder extraResources）
 */

import { existsSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { app } from 'electron'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

export interface ResolvedWebServerPaths {
  /** web-server 入口脚本绝对路径 */
  entry: string
  /** bun 可执行文件绝对路径；找不到时返回 undefined，调用方应回退到 PATH 解析 */
  bun: string | undefined
  /** 解析来源描述，便于日志 */
  source: 'dev-source' | 'dev-bundle' | 'prod-resources'
}

export function resolveWebServerPaths(): ResolvedWebServerPaths {
  // 1. 生产模式：electron-builder 把 server.cjs 放在 resources/web-server
  const prodEntry = join(process.resourcesPath ?? '', 'web-server', 'server.cjs')
  if (existsSync(prodEntry)) {
    return { entry: prodEntry, bun: undefined, source: 'prod-resources' }
  }

  // 2. 开发模式：优先用 esbuild 产出的本地 bundle（apps/electron/resources/web-server/server.cjs）
  const devBundle = join(REPO_ROOT, 'apps', 'electron', 'resources', 'web-server', 'server.cjs')
  if (existsSync(devBundle)) {
    return { entry: devBundle, bun: undefined, source: 'dev-bundle' }
  }

  // 3. 开发模式 fallback：直接跑源码
  const devSource = join(REPO_ROOT, 'apps', 'web-server', 'src', 'index.ts')
  if (existsSync(devSource)) {
    return { entry: devSource, bun: undefined, source: 'dev-source' }
  }

  throw new Error(
    `找不到 web-server 入口（尝试：${prodEntry} / ${devBundle} / ${devSource}）。\n`
    + '开发模式请运行 `bun run --filter "@proma/electron" build:web-server`；'
    + '生产模式请确认 electron-builder extraResources 已包含 resources/web-server。',
  )
}

/** 当前 host 平台的 platform-arch 标识（与 prepare-bun.ts 保持一致）。 */
function hostPlatformArch(): string {
  const arch =
    process.arch === 'arm64' ? 'arm64'
    : process.arch === 'x64' ? 'x64'
    : process.arch === 'ia32' ? 'ia32'
    : process.arch
  return `${process.platform}-${arch}`
}

export function resolveBunBinary(): string | undefined {
  // 1. 环境变量优先
  const envBun = process.env.PROMAM_BUN_PATH ?? process.env.BUN_PATH
  if (envBun && isAbsolute(envBun) && existsSync(envBun)) {
    return envBun
  }

  // 2. 生产模式：尝试 process.resourcesPath/bin/{platform-arch}/bun
  //    prepare-bun.ts 把对应架构的 bun 放在 resources/bin/<host>/ 目录；
  //    electron-builder 通过 extraResources 把整个 resources/bin/ 复制进来。
  if (process.resourcesPath) {
    const binName = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const packagedPerArch = join(process.resourcesPath, 'bin', hostPlatformArch(), binName)
    if (existsSync(packagedPerArch)) return packagedPerArch

    // 兼容旧路径：resources/bin/bun（保留兜底，避免历史安装包失效）
    const packaged = join(process.resourcesPath, 'bin', binName)
    if (existsSync(packaged)) return packaged
  }

  // 3. PATH 里找
  const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path
  if (!pathEnv) return undefined
  const parts = pathEnv.split(process.platform === 'win32' ? ';' : ':')
  for (const dir of parts) {
    const bin = join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun')
    if (existsSync(bin)) return bin
  }

  return undefined
}

/** 调试用：把路径解析结果打到日志 */
export function describeWebServerPaths(p: ResolvedWebServerPaths): string {
  return `source=${p.source} entry=${p.entry} bun=${p.bun ?? '(PATH)'}, electron-version=${app?.getVersion?.() ?? 'n/a'}`
}

// keep reference
export { app }