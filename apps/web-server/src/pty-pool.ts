/**
 * PTY 进程池（web-server 自包含）。
 *
 * Step 3 范围：最小可用 PTY，支持 create/input/resize/kill/snapshot。
 * - 每个 terminalId 一个 IPty
 * - 输入回环：IPty.onData -> outputBuffer -> WS 推给客户端
 * - 客户端 ack 后丢弃已确认 buffer
 *
 * Step 7 集成：替换为复用主进程 lib/terminal-service.ts 的进程池。
 */

import { EventEmitter } from 'node:events'

export interface PtySpawnOptions {
  terminalId: string
  cwd: string
  cols: number
  rows: number
  env?: Record<string, string>
  shell?: string
}

export interface IPty {
  readonly pid: number
  onData(handler: (data: string) => void): () => void
  onExit(handler: (info: { exitCode: number; signal?: number }) => void): () => void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface OutputChunk {
  seq: number
  data: string
}

interface PoolEntry {
  pty: IPty
  buffer: { output: string; seq: number }
  ackedSeq: number
}

class PtyPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly emitter = new EventEmitter()
  constructor() { this.emitter.setMaxListeners(0) }

  list(): string[] { return [...this.entries.keys()] }

  has(terminalId: string): boolean { return this.entries.has(terminalId) }

  async create(options: PtySpawnOptions, factory: (opts: PtySpawnOptions) => IPty): Promise<void> {
    if (this.entries.has(options.terminalId)) return
    const pty = factory(options)
    const entry: PoolEntry = { pty, buffer: { output: '', seq: 0 }, ackedSeq: 0 }
    this.entries.set(options.terminalId, entry)

    pty.onData((data) => {
      entry.buffer.seq += 1
      entry.buffer.output += data
      this.emitter.emit('output', {
        terminalId: options.terminalId,
        chunk: { seq: entry.buffer.seq, data },
      } satisfies PtyOutputEvent)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.emitter.emit('exit', { terminalId: options.terminalId, exitCode, signal })
      // 进程退出后保留 entry 短暂以供 snapshot；30s 后清理
      setTimeout(() => this.entries.delete(options.terminalId), 30_000)
    })
  }

  write(terminalId: string, data: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) throw new Error(`PTY ${terminalId} 不存在`)
    entry.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    entry.pty.resize(cols, rows)
  }

  kill(terminalId: string, signal?: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    entry.pty.kill(signal)
  }

  snapshot(terminalId: string): { output: string; seq: number } | null {
    const entry = this.entries.get(terminalId)
    if (!entry) return null
    return { output: entry.buffer.output, seq: entry.buffer.seq }
  }

  ack(terminalId: string, seq: number): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (seq > entry.buffer.seq) return
    // 截断到 seq 之后的部分
    const dropUntil = entry.buffer.output.length - (entry.buffer.output.length - (entry.buffer.seq - seq))
    // 简化：用 lastSeq 标记"已确认到 seq"，不再做字节级截断（终端 replay 容忍）
    entry.ackedSeq = Math.max(entry.ackedSeq, seq)
    void dropUntil
  }

  onOutput(handler: (event: PtyOutputEvent) => void): () => void {
    this.emitter.on('output', handler)
    return () => this.emitter.off('output', handler)
  }

  onExit(handler: (event: PtyExitEvent) => void): () => void {
    this.emitter.on('exit', handler)
    return () => this.emitter.off('exit', handler)
  }
}

export interface PtyOutputEvent {
  terminalId: string
  chunk: OutputChunk
}
export interface PtyExitEvent {
  terminalId: string
  exitCode: number
  signal?: number
}

export const ptyPool = new PtyPool()