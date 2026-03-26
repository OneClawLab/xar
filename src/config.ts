/**
 * Configuration management for xar daemon
 */

import { homedir } from 'os'
import { join } from 'path'
import type { DaemonConfig } from './daemon/types.js'

export function getTheClawHome(): string {
  return process.env.THECLAW_HOME || join(homedir(), '.theclaw')
}

export function getIpcPort(): number {
  const port = process.env.XAR_IPC_PORT
  return port ? parseInt(port, 10) : 18792
}

export function getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
  const level = process.env.XAR_LOG_LEVEL
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level
  }
  return 'info'
}

export function getDaemonConfig(): DaemonConfig {
  return {
    theClawHome: getTheClawHome(),
    ipcPort: getIpcPort(),
    logLevel: getLogLevel(),
  }
}

export function getSocketPath(): string {
  return join(getTheClawHome(), 'xar.sock')
}
