/**
 * 小 domain（scratch-pad / user-profile / system-prompt / chat-tool）集成测试。
 */

process.env.PROMA_CONFIG_DIR = `/tmp/proma-web-server-misc-test-${process.pid}`

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
  const body = await res.json() as { ok: boolean; data?: T; error?: { message: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'ipc failed')
  return body.data as T
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

describe('web-server scratch-pad domain', () => {
  test('load 起步空串、save 后往返一致', async () => {
    const initial = await ipc<string>('scratch-pad:load')
    expect(initial).toBe('')

    const content = ['# 笔记', '内容'].join('\n')
    expect(await ipc<boolean>('scratch-pad:save', content)).toBe(true)
    const loaded = await ipc<string>('scratch-pad:load')
    expect(loaded).toContain('# 笔记')
  })

  test('save 拒绝非字符串', async () => {
    const res = await ipcRaw('scratch-pad:save', [42])
    expect(res.status).toBe(500)
  })
})

describe('web-server user-profile domain', () => {
  test('get 返回默认档案、update 改名生效', async () => {
    const profile = await ipc<{ userName: string }>('user-profile:get')
    expect(typeof profile.userName).toBe('string')

    const updated = await ipc<{ userName: string }>('user-profile:update', [{ userName: '测试用户' }])
    expect(updated.userName).toBe('测试用户')
    const again = await ipc<{ userName: string }>('user-profile:get')
    expect(again.userName).toBe('测试用户')
  })
})

describe('web-server system-prompt domain', () => {
  test('config 起步合法、create/update/delete 闭环', async () => {
    const config = await ipc<{ prompts: { id: string }[]; appendEnabled?: boolean }>('system-prompt:get-config')
    expect(Array.isArray(config.prompts)).toBe(true)

    const created = await ipc<{ id: string; name: string }>('system-prompt:create', [{ name: '测试提示词', content: '你是测试' }])
    expect(created.name).toBe('测试提示词')

    const updated = await ipc<{ name: string }>('system-prompt:update', [created.id, { name: '改名提示词' }])
    expect(updated.name).toBe('改名提示词')

    await ipc('system-prompt:update-append-setting', [false])
    await ipc('system-prompt:set-default', [created.id])

    await ipc('system-prompt:delete', [created.id])
    const after = await ipc<{ prompts: { id: string }[] }>('system-prompt:get-config')
    expect(after.prompts.some((p) => p.id === created.id)).toBe(false)
  })
})

describe('web-server chat-tool domain', () => {
  test('get-all-tools 返回内置工具数组', async () => {
    const tools = await ipc<{ meta: { id: string } }[]>('chat-tool:get-all-tools')
    expect(Array.isArray(tools)).toBe(true)
    // 内置工具集非空
    expect(tools.length).toBeGreaterThanOrEqual(1)
  })

  test('update-state + get-state 往返', async () => {
    const tools = await ipc<{ meta: { id: string } }[]>('chat-tool:get-all-tools')
    const target = tools[0]!.meta.id
    await ipc('chat-tool:update-state', [target, { enabled: false }])
    const state = await ipc<{ enabled?: boolean }>('chat-tool:get-state', [target])
    expect(state.enabled).toBe(false)
    // 还原，避免影响同进程其他用例
    await ipc('chat-tool:update-state', [target, { enabled: true }])
  })

  test('create-custom + delete-custom 闭环', async () => {
    await ipc('chat-tool:create-custom', [{
      id: 'test-custom-tool', name: '测试自定义', description: '测试用自定义工具',
      params: [], category: 'custom',
      config: { url: 'https://example.com', method: 'GET' },
    }])
    const tools = await ipc<{ meta: { id: string } }[]>('chat-tool:get-all-tools')
    expect(tools.some((t) => t.meta.id === 'test-custom-tool')).toBe(true)
    await ipc('chat-tool:delete-custom', ['test-custom-tool'])
    const after = await ipc<{ meta: { id: string } }[]>('chat-tool:get-all-tools')
    expect(after.some((t) => t.meta.id === 'test-custom-tool')).toBe(false)
  })
})

describe('web-server chat-tool:test 降级（PR5 Bug3 D3）', () => {
  test('chat-tool:test 拋 PlatformUnsupportedError，避免 web-shim 默认 null 占位误导 UI', async () => {
    // 关键点：web-shim 的 pickPlaceholder 对 test* 不匹配任何规则，fallback 是 null。
    // 如果 channel:unregistered，UI 拿到 null 会误以为「测试成功但无返回」。
    // 显式拋 PlatformUnsupportedError，UI 可用 isPlatformUnsupportedError 检测后
    // 给出「Web 形态不支持 chat-tool:test」降级文案。
    const res = await ipcRaw('chat-tool:test', ['web-search'])
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PLATFORM_UNSUPPORTED')
    expect(body.error.message).toContain('chat-tool:test')
  })
})
