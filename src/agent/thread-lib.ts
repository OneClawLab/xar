/**
 * Thread library wrapper for xar
 * Provides thread management for agent message storage
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

export async function getAgentInboxPath(agentId: string): Promise<string> {
  const config = getDaemonConfig()
  return join(config.theClawHome, 'agents', agentId, 'inbox')
}

export async function getThreadPath(agentId: string, threadId: string): Promise<string> {
  const config = getDaemonConfig()
  return join(config.theClawHome, 'agents', agentId, 'threads', threadId)
}

export async function openInboxThread(agentId: string): Promise<ThreadStore> {
  const lib = getThreadLib()
  const inboxPath = await getAgentInboxPath(agentId)
  return lib.open(inboxPath)
}

export async function openOrCreateThread(agentId: string, threadId: string): Promise<ThreadStore> {
  const lib = getThreadLib()
  const threadPath = await getThreadPath(agentId, threadId)
  return lib.open(threadPath)
}

export async function initThread(agentId: string, threadId: string): Promise<ThreadStore> {
  const lib = getThreadLib()
  const threadPath = await getThreadPath(agentId, threadId)
  return lib.init(threadPath)
}

export async function threadExists(agentId: string, threadId: string): Promise<boolean> {
  const lib = getThreadLib()
  const threadPath = await getThreadPath(agentId, threadId)
  return lib.exists(threadPath)
}
