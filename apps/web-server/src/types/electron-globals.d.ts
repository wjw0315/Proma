/**
 * web-server 环境下的全局类型补充。
 *
 * 复用 apps/electron/src/main/lib 的纯 fs 业务模块时，会连带检查其中
 * 引用的 Electron 运行时全局变量。web-server 跑在 Bun 上没有 electron
 * 类型包，这里以最小 ambient 声明补齐，仅用于类型检查。
 */

declare global {
  namespace NodeJS {
    interface Process {
      /** Electron 打包产物资源目录；web-server（Bun）环境不存在，恒为 undefined。 */
      resourcesPath: string
    }
  }
}

export {}
