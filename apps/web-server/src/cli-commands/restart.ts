/**
 * restart
 */

import { runStart } from './start'
import { runStop } from './stop'
import type { CliSettings } from './settings'

export interface RestartOptions {
  fg: boolean
  entry: string
}

export function runRestart(settings: CliSettings, options: RestartOptions): void {
  runStop()
  runStart(settings, options)
}
