/**
 * 父进程桥（Parent Bridge）。
 *
 * 嵌入模式下 web-server 由 Electron 主进程 spawn。两者之间建立一条基于
 * stdio 的 JSONL 双向通道：
 *
 * - 子进程 → 父进程：在 stdout 上写 `#bridge#{json}` 前缀行（与普通日志区分），
 *   承载 RPC 请求（t=req）；父进程按 id 回包。
 * - 父进程 → 子进程：往子进程 stdin 写裸 JSON 行，承载 RPC 响应（t=res）
 *   与事件推送（t=ev，父进程把桌面端 Agent/Chat 流事件桥接给 web 客户端）。
 *
 * 用途：
 * 1. decrypt.apiKey：safeStorage 解密只能在 Electron（OS keychain）里做，
 *    web-server（Bun）无法解密桌面端加密的渠道密钥（否则 401）。
 * 2. agent.send / agent.stop：Agent runtime 运行在 Electron 主进程，
 *    web 端发送消息委托父进程执行，事件经本桥回流到 SSE。
 * 3. chat.send：同上（桌面端与 web 端共用同一运行时，也保证双端事件一致）。
 * 4. 权限/AskUser 应答：web 端 Banner 的按钮点击委托父进程。
 *
 * 独立模式（手动 bun 运行）没有父进程：不设置 PROMA_PARENT_BRIDGE 时
 * 本模块全部 no-op，bridgeRequest 抛出明确错误。
 */

import { createInterface } from 'node:readline'
import { webEventBus } from './event-bus'

/** stdout 桥帧前缀；与普通日志行区分，父进程据此分流。 */
export const BRIDGE_FRAME_PREFIX = '#bridge#'

interface BridgeFrameBase {
  v: 1
}

interface BridgeRequestFrame extends BridgeFrameBase {
  t: 'req'
  id: string
  /** 方法名，如 decrypt.apiKey / agent.send */
  m: string
  /** 方法参数 */
  p: unknown
}

interface BridgeResponseFrame extends BridgeFrameBase {
  t: 'res'
  id: string
  ok: boolean
  /** 成功时的返回值 */
  r?: unknown
  /** 失败时的错误消息 */
  e?: string
}

interface BridgeEventFrame extends BridgeFrameBase {
  t: 'ev'
  /** SSE 通道名（与 renderer web-shim 订阅的 channel 一致） */
  ch: string
  /** 事件负载 */
  d: unknown
}

type BridgeFrame = BridgeRequestFrame | BridgeResponseFrame | BridgeEventFrame

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const enabled = process.env.PROMA_PARENT_BRIDGE === '1'
const pending = new Map<string, PendingEntry>()
let nextRequestId = 0
let started = false

export function isParentBridgeEnabled(): boolean {
  return enabled
}

/** 写一帧到 stdout（带前缀，父进程解析）。 */
function writeFrame(frame: BridgeFrame): void {
  if (!enabled) return
  try {
    process.stdout.write(`${BRIDGE_FRAME_PREFIX}${JSON.stringify(frame)}\n`)
  } catch (error) {
    // stdout 写失败（父进程已退出等）：静默，避免桥问题拖垮业务日志
    console.error('[parent-bridge] 写桥帧失败:', (error as Error).message)
  }
}

/** 处理父进程推来的帧（stdin 每行一个 JSON）。 */
function handleFrame(raw: string): void {
  let frame: BridgeFrame
  try {
    frame = JSON.parse(raw) as BridgeFrame
  } catch {
    return // 忽略无法解析的行
  }
  if (frame?.v !== 1) return

  if (frame.t === 'res') {
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.ok) {
      entry.resolve(frame.r)
    } else {
      entry.reject(new Error(frame.e ?? '桥请求失败'))
    }
    return
  }

  if (frame.t === 'ev') {
    // 父进程事件 → SSE（web 客户端经 web-shim 订阅同一 channel）
    webEventBus.publish(frame.ch, frame.d)
    return
  }

  // t === 'req'：父进程主动调用子进程（v1 无此方向的需求，忽略）
}

/** 启动桥：读取 stdin 行流。幂等。 */
export function startParentBridge(): void {
  if (!enabled || started) return
  started = true
  try {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed) handleFrame(trimmed)
    })
    rl.on('close', () => {
      // 父进程关闭了 stdin（退出中）：清空 pending，避免调用方永久挂起
      for (const [id, entry] of pending) {
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new Error('父进程桥已断开'))
      }
    })
  } catch (error) {
    console.error('[parent-bridge] 启动失败:', (error as Error).message)
  }
}

/** 默认请求超时：agent.send 只等「受理」，10s 足够；解密 5s。 */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 向父进程发起 RPC 请求。
 * 独立模式下抛 ParentBridgeUnavailableError（domain 层据此走本地实现或明确报错）。
 */
export async function bridgeRequest<T = unknown>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (!enabled) {
    throw new ParentBridgeUnavailableError(`父进程桥不可用（独立模式），无法执行 ${method}`)
  }
  const id = `b${++nextRequestId}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`桥请求超时：${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })
    writeFrame({ v: 1, t: 'req', id, m: method, p: params })
  })
}

/** 桥不可用（独立模式）错误：domain 层可识别后降级或给出明确提示。 */
export class ParentBridgeUnavailableError extends Error {
  readonly code = 'PARENT_BRIDGE_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'ParentBridgeUnavailableError'
  }
}

export function isParentBridgeUnavailableError(error: unknown): error is ParentBridgeUnavailableError {
  return (error as { name?: string } | null)?.name === 'ParentBridgeUnavailableError'
}
