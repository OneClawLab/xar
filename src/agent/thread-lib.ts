/**
 * Thread library wrapper for xar
 */

import { ThreadLib as ThreadLibImpl, ThreadStore } from 'thread'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'

let threadLib: ThreadLibImpl | null = null

export function getThreadLib(): ThreadLibImpl {
  if (!threadLib) {
    threadLib = new ThreadLibImpl()
  }
  return threadLib
}

export async function openOrCreateThread(agentId: string, threadId: string): Promise<ThreadStore> {
  const config = getDaemonConfig()
  const threadPath = join(config.theClawHome, 'agents', agentId, 'threads', threadId)
  return getThreadLib().open(threadPath)
}

export async function threadExists(agentId: string, threadId: string): Promise<boolean> {
  const config = getDaemonConfig()
  const threadPath = join(config.theClawHome, 'agents', agentId, 'threads', threadId)
  return getThreadLib().exists(threadPath)
}
