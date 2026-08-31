/**
 * 终端 WS handlers。
 *
 * 鉴权由 Bun.serve 的 upgrade 钩子在创建 WS 前完成；
 * 这里只负责 PTY 帧协议。
 */

import type { ServerFrame, ClientFrame } from './ws-pty'
import { ptyPool } from './pty-pool'

export interface PtyWebSocketHandlers {
  open(ws: BunServerWebSocket): void
  message(ws: BunServerWebSocket, raw: string | Buffer): void
  close(ws: BunServerWebSocket): void
}

// Bun 在 server.ts 里给 ws 附加了一个 __terminalId 字段；
// 这里直接读取，避免通过闭包再传。
export function createPtyWebSocketHandlers(): PtyWebSocketHandlers {
  return {
    open(ws) {
      const terminalId = (ws as unknown as { __terminalId: string }).__terminalId
      const snapshot = ptyPool.snapshot(terminalId)
      send(ws, {
        type: 'ready',
        pid: -1,
        snapshotSeq: snapshot?.seq ?? 0,
        snapshot: snapshot?.output ?? '',
      })
      const offOut = ptyPool.onOutput((event) => {
        if (event.terminalId !== terminalId) return
        send(ws, { type: 'output', seq: event.chunk.seq, data: event.chunk.data })
      })
      const offExit = ptyPool.onExit((event) => {
        if (event.terminalId !== terminalId) return
        send(ws, { type: 'exit', code: event.exitCode, signal: event.signal })
      })
      ;(ws as unknown as { __handlers?: { offOut: () => void; offExit: () => void } }).__handlers = { offOut, offExit }
    },

    message(ws, raw) {
      const terminalId = (ws as unknown as { __terminalId: string }).__terminalId
      let frame: ClientFrame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as ClientFrame
      } catch {
        send(ws, { type: 'error', message: '非 JSON 帧' })
        return
      }
      switch (frame.type) {
        case 'input':
          try {
            ptyPool.write(terminalId, frame.data)
          }
          catch (error) {
            if (error instanceof Error && error.message.includes('不存在')) {
              send(ws, { type: 'error', message: `PTY ${terminalId} 未创建；请先调 terminal:create` })
            }
            else {
              send(ws, { type: 'error', message: (error as Error).message })
            }
          }
          return
        case 'resize':
          ptyPool.resize(terminalId, frame.cols, frame.rows)
          return
        case 'ack':
          ptyPool.ack(terminalId, frame.seq)
          return
        case 'kill':
          ptyPool.kill(terminalId)
          return
        default:
          send(ws, { type: 'error', message: '未知帧类型' })
      }
    },

    close(ws) {
      const handlers = (ws as unknown as { __handlers?: { offOut: () => void; offExit: () => void } }).__handlers
      handlers?.offOut()
      handlers?.offExit()
    },
  }
}

function send(ws: BunServerWebSocket, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame))
}

// Bun 的 WebSocket 类型；这里只声明占位让 TS 通过；运行期由 Bun 提供。
interface BunServerWebSocket {
  send(data: string): void
  close(): void
}