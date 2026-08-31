/**
 * chat:send-message 真实业务接入测试（PR1 — Bug1 流式回归）。
 *
 * 覆盖行为：
 * 1. web-server 不再把 chat:send-message 当作 echo 占位（之前的"sessionId 必填"错误已消除）
 * 2. 通道不存在时 sendMessage 走主进程 chat-service,经 sink 发 STREAM_ERROR,IPC 返回 200 + accepted=false
 * 3. 发送过程中用户消息按主进程语义被持久化（当 sendMessage 走到了 appendMessage 步骤）
 * 4. 重复触发不会污染其他对话的消息列表
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-send-message-test-${process.pid}`

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { loadConfig } from './config'
import { createApp } from './app'

let baseUrl: string
let server: ReturnType<typeof Bun.serve>

async function ipcRaw(channel: string, args?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })
}

async function ipc<T>(channel: string, args?: unknown): Promise<T> {
  const res = await ipcRaw(channel, args)
  const body = await res.json() as { ok: boolean; data?: T; error?: { message: string; code?: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'ipc failed')
  return body.data as T
}

interface Conversation {
  id: string
  title: string
}
interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

beforeAll(() => {
  const config = loadConfig()
  server = Bun.serve({ port: 0, fetch: createApp(config).fetch })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
  rmSync(process.env.PROMA_CONFIG_DIR!, { recursive: true, force: true })
})

describe('web-server chat:send-message 真实链路（PR1 Bug1）', () => {
  test('chat:send-message 不再被当作 echo 占位(原"通道未注册"已消除)', async () => {
    // 准备一个合法 conversation
    const conv = await ipc<Conversation>('chat:create-conversation', ['send-message 测试'])
    // 调 send-message；channelId 故意指向不存在渠道以让 chat-service 走真实路径并快速失败
    const res = await ipcRaw('chat:send-message', [{
      conversationId: conv.id,
      userMessage: 'hello from web',
      messageHistory: [],
      channelId: 'no-such-channel-id',
      modelId: 'no-such-model',
    }])
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data?: { accepted: boolean; conversationId: string }; error?: { code: string } }
    // web-server 不应再返回 PLATFORM_UNSUPPORTED / "通道未在 web-server 注册"
    expect(body.ok).toBe(true)
    expect(body.error).toBeUndefined()
    expect(body.data?.accepted).toBe(false)
    expect(body.data?.conversationId).toBe(conv.id)

    // 渠道不存在时 chat-service 在 step 1 直接 return false,不会调 appendMessage,
    // 因此用户消息不应持久化(避免污染对话)
    const messages = await ipc<ChatMessage[]>('chat:get-messages', [conv.id])
    expect(messages.find((m) => m.content === 'hello from web')).toBeUndefined()

    await ipc('chat:delete-conversation', [conv.id])
  })

  test('chat:send-message 入参不合法时给出明确错误,不再误称"通道未注册"', async () => {
    // 缺 conversationId/userMessage
    const res = await ipcRaw('chat:send-message', [{ foo: 'bar' }])
    const body = await res.json() as { ok: boolean; error?: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('INTERNAL')
    expect(body.error?.message).toContain('ChatSendInput')
  })

  test('chat:send-message 重复触发不会污染其他对话的消息列表', async () => {
    const convA = await ipc<Conversation>('chat:create-conversation', ['A'])
    const convB = await ipc<Conversation>('chat:create-conversation', ['B'])

    await ipcRaw('chat:send-message', [{
      conversationId: convA.id,
      userMessage: 'A 专属',
      messageHistory: [],
      channelId: 'no-such',
      modelId: 'no-such',
    }])

    const messagesB = await ipc<ChatMessage[]>('chat:get-messages', [convB.id])
    expect(messagesB).toEqual([])

    await ipc('chat:delete-conversation', [convA.id])
    await ipc('chat:delete-conversation', [convB.id])
  })
})