/**
 * 平台能力判断。Step 5 范围内：
 * - 在 Web 形态下隐藏桌面专属 UI
 * - 在 Electron 形态下正常显示
 *
 * 使用方式：
 *   import { hasCapability, PlatformUnsupportedHint } from '@/lib/platform/capabilities'
 *   if (!hasCapability('hasTray')) return null
 */

declare const __PROMA_WEB_MODE__: boolean

export type Capability = 'hasTray' | 'hasNativeMenu' | 'hasEventKit' | 'hasAutoUpdate' | 'hasShellOpen' | 'hasFileDialog' | 'hasPty'

const WEB_CAPABILITIES: Record<Capability, boolean> = {
  hasTray: false,
  hasNativeMenu: false,
  hasEventKit: false,
  hasAutoUpdate: false,
  hasShellOpen: false,
  hasFileDialog: false,
  hasPty: true,
}

const ELECTRON_CAPABILITIES: Record<Capability, boolean> = {
  hasTray: true,
  hasNativeMenu: true,
  hasEventKit: true,
  hasAutoUpdate: true,
  hasShellOpen: true,
  hasFileDialog: true,
  hasPty: true,
}

export function getCapabilities(): Record<Capability, boolean> {
  return __PROMA_WEB_MODE__ ? WEB_CAPABILITIES : ELECTRON_CAPABILITIES
}

export function hasCapability(c: Capability): boolean {
  return getCapabilities()[c]
}

export function isWebMode(): boolean {
  return __PROMA_WEB_MODE__
}

/** 桌面专属能力文案；UI 在 Web 形态下可以展示 */
export const UNSUPPORTED_HINTS: Partial<Record<Capability, string>> = {
  hasTray: '托盘菜单仅在 Electron 桌面端可用',
  hasNativeMenu: '应用原生菜单仅在 Electron 桌面端可用',
  hasEventKit: 'macOS 日历/提醒集成仅在 Electron 桌面端可用',
  hasAutoUpdate: '自动更新仅在 Electron 桌面端可用',
  hasShellOpen: '用系统应用打开文件仅在 Electron 桌面端可用',
  hasFileDialog: '原生文件选择对话框仅在 Electron 桌面端可用',
}

export function unsupportedHint(c: Capability): string | undefined {
  return isWebMode() ? UNSUPPORTED_HINTS[c] : undefined
}