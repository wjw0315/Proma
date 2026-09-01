/**
 * 父进程桥端到端验证 harness。
 *
 * 模拟 Electron 主进程（真实协议下同一 stdio JSONL 帧格式）：
 * 1. 以 PROMA_PARENT_BRIDGE=1 spawn web-server（bun src/index.ts）
 * 2. 解析子进程 stdout 的 #bridge# 帧，响应 chat.send / agent.send 等 RPC
 * 3. 校验：
 *    a. HTTP POST /api/ipc chat:send-message → 桥 RPC 到达 mock 父进程
 *    b. mock 父进程推 t=ev 事件帧 → web-server eventBus → SSE /api/events 收到
 *    c. 桥 RPC 响应结果回传到 HTTP 调用方
 *
 * 运行：bun apps/web-server/test/parent-bridge-harness.ts
 * 退出码 0 = 全部通过。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_SERVER_DIR = join(__dirname, '..')
const REPO_ROOT = join(WEB_SERVER_DIR, '..', '..')
const PORT = 5195
const BASE = `http://127.0.0.1:${PORT}`

interface ReqFrame { v: number; t: 'req'; id: string; m: string; p: unknown }
type Frame = ReqFrame | { v: number; t: string; [k: string]: unknown }

const received: Array<{ m: string; p: unknown }> = []
let child: ChildProcess

function writeFrame(frame: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(frame)}\n`)
}

function ok(id: string, r: unknown): void {
  writeFrame({ v: 1, t: 'res', id, ok: true, r })
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  child?.kill('SIGKILL')
  process.exit(1)
}

async function main(): Promise<void> {
  child = spawn('bun', ['src/index.ts'], {
    cwd: WEB_SERVER_DIR,
    env: {
      ...process.env,
      PROMA_PARENT_BRIDGE: '1',
      PROMA_WEB_PORT: String(PORT),
      // 不设 token，简化本机验证
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // mock 父进程：解析桥帧
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line: string) => {
    if (!line.startsWith('#bridge#')) {
      if (!line.trim()) return
      console.log(`[web-server] ${line}`)
      return
    }
    const frame = JSON.parse(line.slice('#bridge#'.length)) as Frame
    if (frame.t === 'req') {
      const req = frame as ReqFrame
      received.push({ m: req.m, p: req.p })
      if (req.m === 'chat.send') {
        // 模拟流式响应：受理 + 两个事件推送
        ok(req.id, { ok: true, conversationId: (req.p as { conversationId: string }).conversationId, accepted: true })
        writeFrame({ v: 1, t: 'ev', ch: 'chat:stream:chunk', d: { conversationId: (req.p as { conversationId: string }).conversationId, text: 'hello' } })
        writeFrame({ v: 1, t: 'ev', ch: 'chat:stream:complete', d: { conversationId: (req.p as { conversationId: string }).conversationId } })
      } else if (req.m === 'agent.send') {
        ok(req.id, { ok: true, sessionId: (req.p as { sessionId: string }).sessionId })
        writeFrame({ v: 1, t: 'ev', ch: 'agent:stream:event', d: { sessionId: (req.p as { sessionId: string }).sessionId, payload: { kind: 'proma_event', event: { type: 'run_started' } } } })
      } else {
        ok(req.id, { mocked: true })
      }
    }
  })

  // 等 web-server 就绪
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) { ready = true; break }
    } catch { /* 未启动 */ }
    await new Promise(r => setTimeout(r, 250))
  }
  if (!ready) fail('web-server 未就绪')

  // 先开 SSE 订阅并等 subscribed 帧确认，再发 chat 消息（避免订阅未就绪丢事件）
  const controller = new AbortController()
  const sseReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE 订阅超时')), 8000)
    void (async () => {
      const res = await fetch(`${BASE}/api/events?channel=chat:stream:chunk`)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let readySeen = false
      const collected: string[] = []
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            const m = /^data: (.*)$/.exec(line)
            if (!m) continue
            const payload = m[1]!
            const parsed = JSON.parse(payload) as { data?: unknown }
            if (!readySeen) {
              readySeen = true
              clearTimeout(timer)
              resolve()
              continue
            }
            collected.push(payload)
            if (collected.length >= 1) {
              controller.abort()
              return
            }
          }
        }
      }
      sseCollect = pump().then(() => collected)
    })().catch(reject)
  })
  let sseCollect: Promise<string[]> = Promise.resolve([])
  await sseReady

  // 1. chat:send-message 经桥到 mock 父进程
  const chatRes = await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'chat:send-message', args: [{ conversationId: 'conv-test-1', userMessage: 'ping', channelId: 'ch1', modelId: 'm1' }] }),
  })
  const chatBody = await chatRes.json() as { ok: boolean; data?: unknown; error?: { message: string } }
  if (chatRes.status !== 200 || !chatBody.ok) fail(`chat:send-message 桥委托失败: ${JSON.stringify(chatBody)}`)
  const chatData = chatBody.data as { conversationId: string; accepted: boolean }
  if (chatData.conversationId !== 'conv-test-1' || chatData.accepted !== true) {
    fail(`chat.send 返回值异常: ${JSON.stringify(chatData)}`)
  }
  console.log('✓ chat:send-message 经桥委托到父进程并返回受理结果')

  // 2. 等待 SSE 收到 mock 父进程推送的事件（chat:stream:chunk）
  const sseTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('SSE 事件等待超时')), 8000))
  const sseChunks = await Promise.race([sseCollect, sseTimeout])
  const evFrames = sseChunks.map(s => JSON.parse(s) as { channel: string; data: { text?: string } })
  const chunkEvent = evFrames.find(f => f.data?.text === 'hello')
  if (!chunkEvent) fail(`SSE 未收到桥推送的 chat:stream:chunk 事件: ${JSON.stringify(evFrames)}`)
  console.log('✓ 父进程事件帧经桥 → eventBus → SSE 到达 web 客户端')

  // 3. agent:send-message 桥委托
  const agentRes = await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'agent:send-message', args: [{ sessionId: 'sess-test-1', userMessage: 'hi' }] }),
  })
  const agentBody = await agentRes.json() as { ok: boolean; data?: unknown; error?: { message: string } }
  if (agentRes.status !== 200 || !agentBody.ok) fail(`agent:send-message 桥委托失败: ${JSON.stringify(agentBody)}`)
  console.log('✓ agent:send-message 经桥委托到父进程')

  // 4. 确认收到的 RPC 序列
  const methods = received.map(r => r.m)
  if (!methods.includes('chat.send') || !methods.includes('agent.send')) {
    fail(`桥 RPC 序列异常: ${methods.join(', ')}`)
  }
  console.log(`✓ 桥 RPC 序列完整: ${methods.join(' → ')}`)

  console.log('\n全部通过 ✓')
  child.kill('SIGTERM')
  process.exit(0)
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))
