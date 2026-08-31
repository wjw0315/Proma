/**
 * Windows 服务安装与卸载：通过 sc.exe 注册 PromaWeb 普通服务。
 *
 * 设计：
 * - 不引第三方依赖（不用 NSSM），保证 Bun 单文件 bundle 不需要额外资源。
 * - sc.exe 需要管理员权限；runInstall 在非管理员时打印 PowerShell 脚本而不是尝试执行。
 * - binPath 含空格时按 sc 规则处理：binPath= "<path>" start --fg
 */

import { PATHS } from '../cli-paths'

export interface WindowsInstallPlan {
  /** 用户复制到管理员 PowerShell 的脚本 */
  powershell: string
  /** 服务名 */
  serviceName: string
  notes: string[]
}

export interface WindowsUninstallPlan {
  powershell: string
  serviceName: string
  notes: string[]
}

export function buildWindowsInstallPlan(options: { promaBin?: string } = {}): WindowsInstallPlan {
  const promaBin = options.promaBin ?? process.execPath
  const serviceName = PATHS.windowsServiceName
  const cmds = buildWindowsInstallCommands(promaBin, serviceName)
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    ...cmds,
    `Write-Host "PromaWeb 服务已注册并启动" -ForegroundColor Green`,
  ]
  return {
    serviceName,
    powershell: lines.join('\n'),
    notes: [
      `请以管理员身份运行 PowerShell，执行下方脚本注册 Windows 服务 ${serviceName}。`,
    ],
  }
}

/**
 * 拼装 sc.exe 命令三元组（program, args）。
 * Install 分支在管理员权限下逐个 execFile 调用；
 * buildWindowsInstallPlan 拿同一份拼接生成 PowerShell 脚本。
 */
export function buildWindowsInstallCommands(
  promaBin: string,
  serviceName: string,
): string[] {
  // binPath 整段加引号；参数紧跟其后裸追加（sc 规则）
  const binPathQuoted = `"\\"${promaBin}\\" start --fg"`
  return [
    `sc.exe create ${serviceName} binPath= ${binPathQuoted} start= auto DisplayName= "Proma Web Server"`,
    `sc.exe description ${serviceName} "Proma 自托管 Web 服务（HTTP API + SSE + WS）"`,
    `sc.exe failure ${serviceName} reset= 5 actions= restart/5000`,
    `sc.exe start ${serviceName}`,
  ]
}

export function buildWindowsUninstallCommands(serviceName: string): string[] {
  return [
    `sc.exe stop ${serviceName}`,
    `sc.exe delete ${serviceName}`,
  ]
}

export function buildWindowsUninstallPlan(): WindowsUninstallPlan {
  const serviceName = PATHS.windowsServiceName
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `sc.exe stop ${serviceName}`,
    `sc.exe delete ${serviceName}`,
    `Write-Host "PromaWeb 服务已停止并删除" -ForegroundColor Green`,
  ]
  return {
    serviceName,
    powershell: lines.join('\n'),
    notes: [`请以管理员身份运行 PowerShell，执行下方脚本卸载 Windows 服务 ${serviceName}。`],
  }
}

/**
 * 检测当前进程是否以管理员运行。
 * 仅 Windows 通过 net session 探测；其它平台返回 false。
 */
export async function detectElevation(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const { runCommand } = await import('./index')
  try {
    await runCommand('net', ['session'], { env: { ...process.env, NO_COLOR: '1' } })
    return true
  }
  catch {
    return false
  }
}
