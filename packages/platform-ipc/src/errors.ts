/**
 * 平台抽象层错误类型。
 * 与具体宿主（Electron / Web）解耦，方便 renderer 统一处理。
 */

export class PlatformUnsupportedError extends Error {
  readonly code = 'PLATFORM_UNSUPPORTED'
  readonly capability: string

  constructor(capability: string, message?: string) {
    super(message ?? `当前形态不支持能力：${capability}`)
    this.name = 'PlatformUnsupportedError'
    this.capability = capability
  }
}

export class PlatformTimeoutError extends Error {
  readonly code = 'PLATFORM_TIMEOUT'
  readonly channel: string

  constructor(channel: string, timeoutMs: number) {
    super(`通道 ${channel} 在 ${timeoutMs}ms 内未响应`)
    this.name = 'PlatformTimeoutError'
    this.channel = channel
  }
}

export class PlatformNetworkError extends Error {
  readonly code = 'PLATFORM_NETWORK'
  readonly channel: string
  readonly status?: number

  constructor(channel: string, status: number | undefined, message: string) {
    super(`通道 ${channel} 网络错误${status ? ` (${status})` : ''}：${message}`)
    this.name = 'PlatformNetworkError'
    this.channel = channel
    this.status = status
  }
}