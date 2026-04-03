/**
 * PID file management for daemon lifecycle
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { CliError } from '../types.js'

export async function writePidFile(theClawHome: string, pid: number): Promise<void> {
  const pidFile = join(theClawHome, 'xar.pid')
  await fs.writeFile(pidFile, pid.toString(), 'utf-8')
}

export async function readPidFile(theClawHome: string): Promise<number | null> {
  const pidFile = join(theClawHome, 'xar.pid')
  try {
    const content = await fs.readFile(pidFile, 'utf-8')
    return parseInt(content.trim(), 10)
  } catch {
    return null
  }
}

export async function deletePidFile(theClawHome: string): Promise<void> {
  const pidFile = join(theClawHome, 'xar.pid')
  try {
    await fs.unlink(pidFile)
  } catch {
    // Ignore if file doesn't exist
  }
}

export async function checkDaemonRunning(theClawHome: string): Promise<boolean> {
  const pid = await readPidFile(theClawHome)
  if (pid === null) return false

  try {
    // a signal of `0` can be used to test for the existence of a process
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function ensureDaemonNotRunning(theClawHome: string): Promise<void> {
  const isRunning = await checkDaemonRunning(theClawHome)
  if (isRunning) {
    throw new CliError('Daemon is already running', 1)
  }
}
