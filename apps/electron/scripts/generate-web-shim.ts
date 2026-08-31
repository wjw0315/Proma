/**
 * 从 apps/electron/src/preload/index.ts 的 electronAPI 对象里提取
 *   method → (invoke|send|on) → <X>_IPC_CHANNELS.<Y>
 * 映射，并把 <X>_IPC_CHANNELS.<Y> 解析成最终的字符串字面量。
 *
 * 输出到 apps/electron/src/renderer/lib/platform/web-shim.generated.ts
 * 该文件被 web-shim.ts 导入，用于在 Web 形态下代理所有 IPC 调用。
 *
 * 用法：bun run scripts/generate-web-shim.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const PRELOAD = resolve(APP_ROOT, 'src/preload/index.ts')
const OUT = resolve(APP_ROOT, 'src/renderer/lib/platform/web-shim.generated.ts')

interface Mapping {
  method: string
  kind: 'invoke' | 'send' | 'on'
  channel: string
  arity: number
}

function isElectronRendererCall(expr: ts.Expression): { kind: 'invoke' | 'send' | 'on' } | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const obj = callee.expression
  const name = callee.name.text
  if (!ts.isIdentifier(obj) || obj.text !== 'ipcRenderer') return null
  if (name !== 'invoke' && name !== 'send' && name !== 'on') return null
  return { kind: name }
}

interface Resolver {
  resolvePropertyAccess(node: ts.PropertyAccessExpression): string | null
  program: ts.Program
}

function buildResolver(preloadPath: string): Resolver {
  const configPath = resolve(APP_ROOT, 'tsconfig.json')
  const configText = readFileSync(configPath, 'utf8')
  const config = ts.parseConfigFileTextToJson(configPath, configText)
  if (config.error) throw new Error(`解析 tsconfig 失败：${config.error.messageText}`)

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, APP_ROOT)
  parsed.fileNames = Array.from(new Set([...parsed.fileNames, preloadPath]))

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  })
  const checker = program.getTypeChecker()

  function resolvePropertyAccess(node: ts.PropertyAccessExpression): string | null {
    if (!ts.isIdentifier(node.expression)) return null
    const leftSym = checker.getSymbolAtLocation(node.expression)
    if (!leftSym) return null
    // 跟 import 链：<X>_IPC_CHANNELS 可能是 import 别名
    const aliased = checker.getAliasedSymbol?.(leftSym) ?? leftSym
    const leftDecl = aliased.valueDeclaration ?? aliased.declarations?.[0]
    if (!leftDecl) return null
    if (!ts.isVariableDeclaration(leftDecl) || !leftDecl.initializer) return null
    // 形如 `export const IPC_CHANNELS = { ... } as const`，解 AsExpression
    let init: ts.Node = leftDecl.initializer
    if (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) init = init.expression
    if (!ts.isObjectLiteralExpression(init)) return null
    for (const prop of init.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      if (!ts.isIdentifier(prop.name) || prop.name.text !== node.name.text) continue
      let valueInit: ts.Node = prop.initializer
      if (ts.isAsExpression(valueInit) || ts.isTypeAssertionExpression(valueInit)) valueInit = valueInit.expression
      if (!ts.isStringLiteral(valueInit)) return null
      return valueInit.text
    }
    return null
  }

  return { resolvePropertyAccess, program }
}

function extract(): Mapping[] {
  const { resolvePropertyAccess, program } = buildResolver(PRELOAD)
  // 关键：必须用 program 拿到的 SourceFile，checker 才能解析符号
  const sf = program.getSourceFile(PRELOAD)
  if (!sf) throw new Error(`program 中找不到 ${PRELOAD}`)

  let apiObject: ts.ObjectLiteralExpression | null = null
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'electronAPI') continue
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue
      apiObject = decl.initializer
      break
    }
    if (apiObject) break
  }
  if (!apiObject) throw new Error('未找到 const electronAPI = { ... }')

  const mappings: Mapping[] = []
  const seen = new Set<string>()

  /**
   * 从单个 ArrowFunction/方法体中提取 (kind, channel) 信息。
   * 不返回 kind/channel 时表示该方法不走 ipcRenderer（如 webUtils、addEventListener、sendSync）。
   */
  function extractCall(value: ts.Node): { kind: 'invoke' | 'send' | 'on'; channel: string; arity: number } | null {
    const arity = ts.isArrowFunction(value) ? value.parameters.length : 0

    function unwrapAs(n: ts.Node): ts.Node {
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) return n.expression
      if (ts.isNonNullExpression(n)) return n.expression
      return n
    }

    // 形式 1：单行表达式 (a) => ipcRenderer.invoke(CH, a) [或 'literal-channel']
    if (ts.isArrowFunction(value) && ts.isCallExpression(value.body)) {
      const k = isElectronRendererCall(value.body)
      if (k) {
        const arg0 = value.body.arguments[0]
        if (ts.isPropertyAccessExpression(arg0)) {
          const ch = resolvePropertyAccess(arg0)
          if (ch) return { kind: k.kind, channel: ch, arity }
        } else if (ts.isStringLiteral(arg0)) {
          return { kind: k.kind, channel: arg0.text, arity }
        }
      }
    }

    // 形式 2：块函数 () => { return ipcRenderer.invoke(CH, x) [as Promise<...>] }
    if (ts.isArrowFunction(value) && ts.isBlock(value.body)) {
      for (const stmt of value.body.statements) {
        if (!ts.isReturnStatement(stmt) || !stmt.expression) continue
        const retExpr = unwrapAs(stmt.expression)
        if (!ts.isCallExpression(retExpr)) continue
        const k = isElectronRendererCall(retExpr)
        if (!k) continue
        const arg0 = retExpr.arguments[0]
        if (ts.isPropertyAccessExpression(arg0)) {
          const ch = resolvePropertyAccess(arg0)
          if (ch) return { kind: k.kind, channel: ch, arity }
        } else if (ts.isStringLiteral(arg0)) {
          return { kind: k.kind, channel: arg0.text, arity }
        }
      }
    }

    // 形式 3：块函数 () => { ipcRenderer.send/on(CH, x) } （无 return）
    if (ts.isArrowFunction(value) && ts.isBlock(value.body)) {
      for (const stmt of value.body.statements) {
        if (!ts.isExpressionStatement(stmt)) continue
        if (!ts.isCallExpression(stmt.expression)) continue
        const k = isElectronRendererCall(stmt.expression)
        if (!k) continue
        const arg0 = stmt.expression.arguments[0]
        if (ts.isPropertyAccessExpression(arg0)) {
          const ch = resolvePropertyAccess(arg0)
          if (ch) return { kind: k.kind, channel: ch, arity }
        } else if (ts.isStringLiteral(arg0)) {
          // 直接是字符串字面量，如 'updater:check' / 'menu:close-tab'
          return { kind: k.kind, channel: arg0.text, arity }
        }
      }
    }

    return null
  }

  /**
   * 递归收集 ObjectLiteralExpression 中所有走 ipcRenderer 的 method。
   * 顶层属性名 = methodName；嵌套对象里的 method = `${namespace}.${method}`。
   */
  function collectFromObject(obj: ts.ObjectLiteralExpression, namespace: string) {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      if (!ts.isIdentifier(prop.name)) continue
      const localName = prop.name.text
      const methodName = namespace ? `${namespace}.${localName}` : localName

      // 嵌套对象（如 updater/agentIsland）：递归进 method
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        collectFromObject(prop.initializer, localName)
        continue
      }

      const call = extractCall(prop.initializer)
      if (!call) continue
      if (seen.has(methodName)) continue
      seen.add(methodName)
      mappings.push({ method: methodName, ...call })
    }
  }

  collectFromObject(apiObject, '')

  return mappings
}

function emit(mappings: Mapping[]): string {
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * 此文件由 scripts/generate-web-shim.ts 自动生成。')
  lines.push(' * 来源：apps/electron/src/preload/index.ts 的 electronAPI 对象。')
  lines.push(' *')
  lines.push(' * 包含 method → (invoke|send|on) → channel 的完整映射。')
  lines.push(' * web-shim.ts 在 Web 形态下用此表代理所有 IPC 调用。')
  lines.push(' *')
  lines.push(' * 请勿手改；改 preload 后请重新执行 bun run generate:web-shim。')
  lines.push(' */')
  lines.push('')
  lines.push("import type { GeneratedWebMethodSpec } from './web-shim.types'")
  lines.push('')
  lines.push('export const WEB_METHODS_GENERATED: Record<string, GeneratedWebMethodSpec> = {')

  const sorted = [...mappings].sort((a, b) => a.method.localeCompare(b.method))
  for (const m of sorted) {
    // key 与 channel 都安全转义；嵌套 method（如 updater.checkForUpdates）的 key 需引号
    const safeKey = m.method.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const safeChannel = m.channel.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    lines.push(`  '${safeKey}': { kind: '${m.kind}', channel: '${safeChannel}', arity: ${m.arity} },`)
  }
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const mappings = extract()
  const text = emit(mappings)
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text, 'utf8')
  console.log(`✓ 已生成 ${mappings.length} 条映射 → ${OUT}`)
  const byKind = mappings.reduce<Record<string, number>>((acc, m) => {
    acc[m.kind] = (acc[m.kind] ?? 0) + 1
    return acc
  }, {})
  console.log('  按 kind 分布:', byKind)
}

main()
