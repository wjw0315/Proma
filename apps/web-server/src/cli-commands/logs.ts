/**
 * logs [-n N] [-f] [--follow]
 *
 * 默认：分别打印 ~/.proma/logs/web-server.{out,err}.log 最近 N 行（各 N 行）。
 * -f：持续 tail 两个文件（行为对齐 tail -F；不跟随 rotate 的 .1.gz）。
 */

import { closeSync, openSync, readSync, statSync, watch } from 'node:fs'

import { logFilePath } from '../cli-paths'

export interface LogsOptions {
  /** 各文件打印多少行；默认 200 */
  n: number
  /** 持续 tail */
  follow: boolean
}

export function parseLogsArgs(argv: string[]): LogsOptions {
  let n = 200
  let follow = false
  for (const arg of argv) {
    if (arg === '-f' || arg === '--follow') follow = true
    else if (arg.startsWith('-n=')) {
      const v = Number(arg.slice(3))
      if (Number.isFinite(v) && v > 0) n = v
    }
    else if (arg.startsWith('--lines=')) {
      const v = Number(arg.slice('--lines='.length))
      if (Number.isFinite(v) && v > 0) n = v
    }
  }
  return { n, follow }
}

export interface TailLine {
  file: string
  text: string
}

/** 读文件最后 N 行；不存在返回空数组 */
export function tailLines(file: string, n: number): TailLine[] {
  const bufSize = 64 * 1024
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const stat = statSync(file)
    const size = stat.size
    if (size === 0) return []
    // 从末尾读 buffer，逐步扩展直到找到 >= n 个换行
    let offset = Math.max(0, size - bufSize)
    let buffer = Buffer.alloc(0)
    let lines: string[] = []
    while (true) {
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      buffer = Buffer.concat([chunk, buffer])
      lines = buffer.toString('utf-8').split('\n')
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length >= n || offset === 0) break
      offset = Math.max(0, offset - bufSize)
    }
    const tail = lines.slice(-n)
    return tail.map(text => ({ file, text }))
  }
  catch {
    return []
  }
  finally {
    if (fd !== null) closeSync(fd)
  }
}

/** 持续 tail；文件被 rotate / 截断时自动回到开头 */
export function followLog(
  file: string,
  onLine: (line: TailLine) => void,
  signal?: AbortSignal,
): () => void {
  let position = 0
  let leftover = ''
  let stopped = false
  const readNew = (): void => {
    if (stopped) return
    let fd: number | null = null
    try {
      fd = openSync(file, 'r')
      const stat = statSync(file)
      if (stat.size < position) {
        // 文件被 rotate / 截断；回到开头
        position = 0
        leftover = ''
      }
      if (stat.size === position) return
      const buf = Buffer.alloc(stat.size - position)
      readSync(fd, buf, 0, buf.length, position)
      position = stat.size
      const combined = leftover + buf.toString('utf-8')
      const parts = combined.split('\n')
      leftover = parts.pop() ?? ''
      for (const text of parts) onLine({ file, text })
    }
    catch {
      // 文件暂时不存在；忽略
    }
    finally {
      if (fd !== null) closeSync(fd)
    }
  }
  readNew()
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(file, { persistent: false }, () => readNew())
  }
  catch {
    // 文件还不存在；交给 setInterval 轮询
  }
  // 兜底：watch 在某些情况下不触发，每 500ms 主动检查
  const timer = setInterval(readNew, 500)
  const cleanup = (): void => {
    if (stopped) return
    stopped = true
    watcher?.close()
    clearInterval(timer)
  }
  signal?.addEventListener('abort', cleanup)
  return cleanup
}

export interface RunLogsOptions extends LogsOptions {
  signal?: AbortSignal
}

export async function runLogs(options: RunLogsOptions = { n: 200, follow: false }): Promise<void> {
  const outFile = logFilePath('out')
  const errFile = logFilePath('err')

  if (!options.follow) {
    for (const file of [outFile, errFile]) {
      for (const line of tailLines(file, options.n)) {
        // eslint-disable-next-line no-console
        console.log(`[${line.file === outFile ? 'out' : 'err'}] ${line.text}`)
      }
    }
    return
  }

  // follow 模式：先打印历史 N 行
  for (const file of [outFile, errFile]) {
    for (const line of tailLines(file, options.n)) {
      // eslint-disable-next-line no-console
      console.log(`[${line.file === outFile ? 'out' : 'err'}] ${line.text}`)
    }
  }
  const cleanups: Array<() => void> = []
  cleanups.push(followLog(outFile, line => {
    // eslint-disable-next-line no-console
    console.log(`[out] ${line.text}`)
  }, options.signal))
  cleanups.push(followLog(errFile, line => {
    // eslint-disable-next-line no-console
    console.log(`[err] ${line.text}`)
  }, options.signal))

  await new Promise<void>((resolve) => {
    if (!options.signal) return
    if (options.signal.aborted) return resolve()
    options.signal.addEventListener('abort', () => resolve())
  })
  for (const c of cleanups) c()
}
