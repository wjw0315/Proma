/**
 * stop [--pid-file=path]
 */

import { clearPid, isAlive, readPid } from './pid'

export function runStop(): void {
  const pid = readPid()
  if (!pid) {
    // eslint-disable-next-line no-console
    console.log('[proma-web] 未运行（无 PID 文件）')
    return
  }
  if (!isAlive(pid)) {
    // eslint-disable-next-line no-console
    console.log(`[proma-web] PID ${pid} 已不存在`)
    clearPid()
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
    // eslint-disable-next-line no-console
    console.log(`[proma-web] 已向 PID ${pid} 发送 SIGTERM`)
  }
  catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[proma-web] 停止失败：${(error as Error).message}`)
    process.exit(1)
  }
  clearPid()
}
