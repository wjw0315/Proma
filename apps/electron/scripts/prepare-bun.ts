#!/usr/bin/env bun
/**
 * 把 vendor/bun/{platform-arch}/bun（或 .exe）拷贝到 resources/bin/{platform-arch}/bun，
 * 供 electron-builder 打进 process.resourcesPath/bin/{platform-arch}/bun。
 *
 * 设计：
 * - 与 build-cli / build-agent-island-native 类似的"按平台分目录"模式，每份
 *   安装包只装自己架构的 bun（与 dist:fast / --mac / --win / --linux 当前架构一致）。
 * - 主进程 resolveBunBinary 优先尝试 process.resourcesPath/bin/{platform-arch}/bun，
 *   再 fallback 旧路径，最终退到 PATH 与环境变量。
 * - 仅当 host 平台对应 vendor 子目录存在时才复制；CI 不会下跨平台 binary。
 *
 * 调用：bun run scripts/prepare-bun.ts [--force]
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const electronDir = resolve(import.meta.dir, '..')
const vendorDir = join(electronDir, 'vendor', 'bun')
const resourcesBinDir = join(electronDir, 'resources', 'bin')

const arch =
  process.arch === 'arm64' ? 'arm64'
  : process.arch === 'x64' ? 'x64'
  : process.arch === 'ia32' ? 'ia32'
  : process.arch

const platformArch = `${process.platform}-${arch}`
const isWindows = process.platform === 'win32'
const sourceBinaryName = isWindows ? 'bun.exe' : 'bun'

function fail(msg: string): never {
  console.error(`[prepare:bun] ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const force = args.includes('--force') || args.includes('-f')

const source = join(vendorDir, platformArch, sourceBinaryName)
const targetDir = join(resourcesBinDir, platformArch)
const target = join(targetDir, isWindows ? 'bun.exe' : 'bun')

if (!existsSync(source)) {
  fail(`找不到 vendor 中的 Bun: ${source}\n请先执行 bun run scripts/download-bun.ts --platform ${platformArch}`)
}

if (existsSync(target) && !force) {
  const srcStat = statSync(source)
  const dstStat = statSync(target)
  if (srcStat.size === dstStat.size && Math.floor(srcStat.mtimeMs) <= Math.floor(dstStat.mtimeMs)) {
    console.log(`[prepare:bun] 目标已存在且未变化，跳过: ${target}`)
    process.exit(0)
  }
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
if (!isWindows) {
  chmodSync(target, 0o755)
}

const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(0)
console.log(`[prepare:bun] ✓ ${platformArch}/bun (${sizeMb} MB) → ${target}`)
