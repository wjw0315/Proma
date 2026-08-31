/**
 * Web 服务设置面板。
 *
 * 功能：
 * - 配置 host / port / token / 自动启动
 * - 启停 / 重启按钮
 * - 显示当前状态（idle / starting / running / error / stopping）
 * - 显示最近日志（环形缓冲，500 条上限）
 *
 * 设计原则：
 * - 配置变更后必须"应用并重启"才生效；UI 给出明确提示
 * - 远程访问 (0.0.0.0) 强制要求 token
 * - 日志面板限高 + 自动滚到底部（用户暂停滚动时不动）
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { AlertTriangle, CheckCircle2, Globe, Loader2, Pause, Play, RefreshCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import type { WebServerLogEntry, WebServerSettings, WebServerStatusInfo } from '../../../types/settings'

const DEFAULT_CONFIG: WebServerSettings = {
  autoStart: false,
  host: '127.0.0.1',
  port: 5174,
  token: null,
  requireTokenOnPublic: true,
  requestTimeoutMs: 30_000,
  sseIdleMs: 60_000,
}

interface ConfigState {
  draft: WebServerSettings
  saved: WebServerSettings
}

export function WebServerSettings(): React.ReactElement {
  const [state, setState] = useState<ConfigState>({ draft: DEFAULT_CONFIG, saved: DEFAULT_CONFIG })
  const [status, setStatus] = useState<WebServerStatusInfo>({ status: 'idle', lastChangedAt: Date.now() })
  const [logs, setLogs] = useState<WebServerLogEntry[]>([])
  const logsScrollRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // 初次加载
  useEffect(() => {
    let alive = true
    Promise.all([
      window.electronAPI.getWebServerConfig(),
      window.electronAPI.getWebServerStatus(),
      window.electronAPI.getWebServerLogs(500),
    ]).then(([config, st, initialLogs]) => {
      if (!alive) return
      setState({ draft: config, saved: config })
      setStatus(st)
      setLogs(initialLogs)
    }).catch((error) => {
      console.error('[WebServerSettings] 初始化失败', error)
      toast.error('读取 Web 服务配置失败')
    })
    return () => { alive = false }
  }, [])

  // 订阅推送
  useEffect(() => {
    const offStatus = window.electronAPI.onWebServerStatusChanged((info) => setStatus(info))
    const offLog = window.electronAPI.onWebServerLog((entry) => {
      setLogs((prev) => {
        const next = prev.length >= 500 ? prev.slice(-499) : prev
        return [...next, entry]
      })
    })
    return () => { offStatus(); offLog() }
  }, [])

  // 自动滚动
  useEffect(() => {
    if (!autoScroll) return
    const el = logsScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, autoScroll])

  const dirty = useMemo(() => JSON.stringify(state.draft) !== JSON.stringify(state.saved), [state])
  const publicHost = state.draft.host === '0.0.0.0'
  const tokenRequired = publicHost && state.draft.requireTokenOnPublic
  const tokenMissing = tokenRequired && !state.draft.token

  const updateDraft = (patch: Partial<WebServerSettings>): void => {
    setState((prev) => ({ draft: { ...prev.draft, ...patch }, saved: prev.saved }))
  }

  const save = async (): Promise<void> => {
    try {
      const next = await window.electronAPI.updateWebServerConfig(state.draft)
      setState({ draft: next, saved: next })
      toast.success('已保存。host/port/token 变更需要重启才生效。')
    }
    catch (error) {
      toast.error(`保存失败：${(error as Error).message}`)
    }
  }

  const start = async (): Promise<void> => {
    if (dirty) await save()
    const result = await window.electronAPI.startWebServer()
    if (!result.ok) toast.error(`启动失败：${result.reason ?? '未知原因'}`)
  }

  const stop = async (): Promise<void> => {
    await window.electronAPI.stopWebServer()
  }

  const restart = async (): Promise<void> => {
    if (dirty) await save()
    const result = await window.electronAPI.restartWebServer()
    if (!result.ok) toast.error(`重启失败：${result.reason ?? '未知原因'}`)
  }

  const isRunning = status.status === 'running'
  const isTransitioning = status.status === 'starting' || status.status === 'stopping'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Web 服务</h2>
        <p className="text-sm text-muted-foreground">
          在浏览器里访问 Proma。默认仅本机可访问；公网自托管请配置 token 并启用 HTTPS 反代。
        </p>
      </div>

      {/* 配置 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="web-host">监听地址</Label>
          <Input
            id="web-host"
            value={state.draft.host}
            placeholder="127.0.0.1"
            onChange={(e) => updateDraft({ host: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            局域网请用 0.0.0.0（必须配 token）；本机保持 127.0.0.1 即可。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="web-port">端口</Label>
          <Input
            id="web-port"
            type="number"
            min={1}
            max={65535}
            value={state.draft.port}
            onChange={(e) => updateDraft({ port: Number(e.target.value) || 5174 })}
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="web-token">鉴权 token</Label>
          <Input
            id="web-token"
            type="password"
            value={state.draft.token ?? ''}
            placeholder="留空则仅本机可访问"
            onChange={(e) => updateDraft({ token: e.target.value || null })}
          />
          {tokenMissing && (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle size={12} />
              监听 0.0.0.0 但 token 为空，启动会被拒绝
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="web-auto-start"
            checked={state.draft.autoStart}
            onCheckedChange={(checked) => updateDraft({ autoStart: checked })}
          />
          <Label htmlFor="web-auto-start">Electron 启动时自动拉起 Web 服务</Label>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void save()}
          disabled={!dirty}
        >
          保存配置
        </Button>
        {!isRunning && !isTransitioning && (
          <Button size="sm" onClick={() => void start()}>
            <Play size={14} className="mr-1" /> 启动
          </Button>
        )}
        {isRunning && (
          <Button size="sm" variant="destructive" onClick={() => void stop()}>
            <Square size={14} className="mr-1" /> 停止
          </Button>
        )}
        {(isRunning || isTransitioning) && (
          <Button size="sm" variant="outline" onClick={() => void restart()}>
            <RefreshCw size={14} className="mr-1" /> 重启
          </Button>
        )}
        {isTransitioning && (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        )}
      </div>

      {/* 状态卡片 */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {status.status === 'running' && <CheckCircle2 size={16} className="text-green-500" />}
            {status.status === 'idle' && <Globe size={16} className="text-muted-foreground" />}
            {(status.status === 'starting' || status.status === 'stopping') && <Loader2 size={16} className="animate-spin" />}
            {status.status === 'error' && <AlertTriangle size={16} className="text-destructive" />}
            <span className="font-medium">{labelForStatus(status.status)}</span>
            {status.bindAddress && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{status.bindAddress}</code>
            )}
            {status.pid !== undefined && (
              <span className="text-xs text-muted-foreground">PID {status.pid}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Pause size={12} className={autoScroll ? 'text-muted-foreground' : 'text-primary'} />
            <Switch
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              aria-label="自动滚动日志"
            />
          </div>
        </div>
        {status.error && (
          <p className="mt-2 text-xs text-destructive">{status.error}</p>
        )}
      </div>

      {/* 日志面板 */}
      <div className="space-y-2">
        <Label>最近日志（最多 500 条）</Label>
        <div
          ref={logsScrollRef}
          className="h-72 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5"
        >
          {logs.length === 0 && (
            <div className="p-4 text-center text-muted-foreground">暂无日志</div>
          )}
          {logs.map((entry, idx) => (
            <div key={idx} className={entry.stream === 'stderr' ? 'text-destructive' : entry.stream === 'system' ? 'text-muted-foreground' : ''}>
              <span className="text-muted-foreground/70">{formatTime(entry.ts)}</span>{' '}
              {entry.message}
            </div>
          ))}
        </div>
      </div>

      {/* 说明 */}
      <div className="rounded-lg border p-3 text-xs text-muted-foreground space-y-1">
        <p><strong>访问地址：</strong>{isRunning && status.bindAddress ? `http://${status.bindAddress}/` : '启动后显示'}</p>
        {state.draft.token && (
          <p><strong>鉴权方式：</strong>URL 加 <code>?token={state.draft.token}</code>，或 Header <code>Authorization: Bearer ...</code></p>
        )}
        <p><strong>注意：</strong>公网自托管务必配合 HTTPS（caddy / nginx 反代）和防火墙。</p>
      </div>
    </div>
  )
}

function labelForStatus(status: WebServerStatusInfo['status']): string {
  switch (status) {
    case 'idle': return '未启动'
    case 'starting': return '启动中…'
    case 'running': return '运行中'
    case 'stopping': return '停止中…'
    case 'error': return '异常'
    default: return status
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}