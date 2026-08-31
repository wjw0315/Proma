/**
 * 平台抽象层入口（通用部分，不依赖 DOM）。
 * 客户端专用 createWebPlatform 从 '@proma/platform-ipc/web' 导入。
 */

export * from './types'
export * from './errors'
export {
  createElectronPlatform,
  PLATFORM_API_WINDOW_KEY,
  type ElectronBridge,
} from './electron-bridge'