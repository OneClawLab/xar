/**
 * Daemon-specific types
 */

export interface DaemonStatus {
  pid: number
  uptime: number
  agentsRegistered: number
  agentsRunning: number
}

export interface DaemonConfig {
  theClawHome: string
  ipcPort: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}
