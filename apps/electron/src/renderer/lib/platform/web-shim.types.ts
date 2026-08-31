/**
 * web-shim 共享类型。
 *
 * 拆分目的：
 * - web-shim.types.ts 不依赖 DOM，可被 codemod（scripts/generate-web-shim.ts），
 *   renderer 主表（web-shim.ts）以及测试同时 import。
 * - web-shim.generated.ts 仅依赖本文件。
 */

export type WebMethodKind = 'invoke' | 'send' | 'on'

/**
 * 描述一个 electronAPI method 在 Web 形态下需要走的 IPC 通道与调用形式。
 * 由 codemod 从 preload AST 自动生成。
 */
export interface GeneratedWebMethodSpec {
  /** IPC 调用形式 */
  kind: WebMethodKind
  /** 目标 channel 字符串（已解析常量到字面量） */
  channel: string
  /** method 形参个数（仅信息性，调用时仍透传 args） */
  arity: number
}

/**
 * 占位返回策略：未在 web-server 注册的 channel 抛 PlatformUnsupportedError 时
 * 按 method 形态返回合理的空值，避免 UI 崩溃。
 */
export type WebPlaceholder =
  | 'null'
  | 'array'
  | 'object'
  | 'false'
  | 'true'
  | 'undefined'
  | 'noop' // 适用于 on* 订阅返回的 unsubscribe 函数
