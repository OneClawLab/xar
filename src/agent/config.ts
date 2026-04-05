/**
 * Agent configuration loading and validation
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { AgentConfig } from './types.js'
import { CliError } from '../types.js'

export async function loadAgentConfig(agentId: string, theClawHome: string): Promise<AgentConfig> {
  const configPath = join(theClawHome, 'agents', agentId, 'config.json')

  try {
    const data = await fs.readFile(configPath, 'utf-8')
    const raw = JSON.parse(data) as Record<string, unknown>
    const config = raw as unknown as AgentConfig
    validateConfig(config)
    return config
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(`Failed to load agent config for ${agentId}: ${err}`, 1)
  }
}

export function validateConfig(config: AgentConfig): void {
  const errors: string[] = []

  if (!config.agent_id || typeof config.agent_id !== 'string') {
    errors.push('agent_id is required and must be a string')
  }

  if (!config.kind || !['system', 'user'].includes(config.kind)) {
    errors.push('kind must be "system" or "user"')
  }

  if (!config.pai || !config.pai.provider || !config.pai.model) {
    errors.push('pai.provider and pai.model are required')
  }

  if (!config.routing) {
    errors.push('routing is required')
  } else {
    if (!['reactive', 'autonomous'].includes(config.routing.mode)) {
      errors.push('routing.mode must be "reactive" or "autonomous"')
    }
    if (!['mention', 'all'].includes(config.routing.trigger)) {
      errors.push('routing.trigger must be "mention" or "all"')
    }
    if (config.routing.override !== undefined && typeof config.routing.override !== 'object') {
      errors.push('routing.override must be a Record<string, string> if provided')
    }
  }

  if (!config.memory || typeof config.memory.compact_threshold_tokens !== 'number') {
    errors.push('memory.compact_threshold_tokens is required and must be a number')
  }

  if (typeof config.memory?.session_compact_threshold_tokens !== 'number') {
    errors.push('memory.session_compact_threshold_tokens is required and must be a number')
  }

  if (!config.retry || typeof config.retry.max_attempts !== 'number') {
    errors.push('retry.max_attempts is required and must be a number')
  }

  if (errors.length > 0) {
    throw new CliError(`Invalid agent config: ${errors.join(', ')}`, 1)
  }
}
