/**
 * Logging utilities for xar daemon and agents
 */

import { join } from 'path'
import { createFileLogger, createFireAndForgetLogger, createForegroundLogger, type Logger } from './repo-utils/logger.js'
import { getTheClawHome } from './config.js'

export type { Logger }

function defaultLogDir(): string {
  return join(getTheClawHome(), 'logs')
}

/**
 * Create a logger for the daemon.
 * In foreground mode, logs to both stderr and file.
 * In background mode, logs to file only.
 */
export async function createDaemonLogger(logDir?: string, foreground = false): Promise<Logger> {
  const dir = logDir ?? defaultLogDir()
  if (foreground) {
    return createForegroundLogger(dir, 'xar', 10000)
  }
  return createFileLogger(dir, 'xar', 10000)
}

/**
 * Create a logger for an agent.
 * In foreground mode, logs to both stderr and file (async init).
 * In background mode, uses fire-and-forget file logger.
 */
export async function createAgentLogger(agentId: string, logDir?: string, foreground = false): Promise<Logger> {
  const dir = logDir ?? defaultLogDir()
  if (foreground) {
    return createForegroundLogger(dir, `agent-${agentId}`, 10000)
  }
  return createFireAndForgetLogger(dir, `agent-${agentId}`, 10000)
}

/**
 * Get the daemon log file path
 */
export function getDaemonLogPath(logDir?: string): string {
  return join(logDir ?? defaultLogDir(), 'xar.log')
}

/**
 * Get the agent log file path
 */
export function getAgentLogPath(agentId: string, logDir?: string): string {
  return join(logDir ?? defaultLogDir(), `agent-${agentId}.log`)
}
