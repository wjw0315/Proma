/**
 * status
 */

import { isAlive, readPid } from './pid'
import { readSettings } from './settings'

export async function runStatus(): Promise<void> {
  const pid = readPid()
  const settings = readSettings()
  const alive = pid ? isAlive(pid) : false
  // eslint-disable-next-line no-console
  console.log(
    `[proma-web] 配置：host=${settings.host} port=${settings.port} `
    + `token=${settings.token ? '已设置' : '未设置'}`,
  )
  // eslint-disable-next-line no-console
  console.log(`[proma-web] PID 文件：${pid ?? '无'}（${alive ? '存活' : '已退出'}）`)
  try {
    const url = `http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}/health`
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    // eslint-disable-next-line no-console
    console.log(`[proma-web] HTTP /health: ${res.status}`)
  }
  catch (error) {
    // eslint-disable-next-line no-console
    console.log(`[proma-web] HTTP /health: 不可达（${(error as Error).message}）`)
  }
}
