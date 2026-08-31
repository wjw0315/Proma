/**
 * 客户端专用入口；web-bridge.client.ts 依赖 DOM。
 * 该文件仅在 renderer 端使用，服务端请勿 import。
 *
 * 重导出便于 renderer 写：
 *   import { createWebPlatform } from '@proma/platform-ipc/web'
 */

export {
  createWebPlatform,
  type WebBridgeOptions,
} from './web-bridge.client'