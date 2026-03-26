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
    const config = JSON.parse(data) as AgentConfig
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

  if (!config.routing || !config.routing.default) {
    errors.push('routing.default is required')
  }

  if (!['per-peer', 'per-session', 'per-agent'].includes(config.routing.default)) {
    errors.push('routing.default must be "per-peer", "per-session", or "per-agent"')
  }

  if (!config.memory || typeof config.memory.compact_threshold_tokens !== 'number') {
    errors.push('memory.compact_threshold_tokens is required and must be a number')
  }

  if (typeof config.memory.session_compact_threshold_tokens !== 'number') {
    errors.push('memory.session_compact_threshold_tokens is required and must be a number')
  }

  if (!config.retry || typeof config.retry.max_attempts !== 'number') {
    errors.push('retry.max_attempts is required and must be a number')
  }

  if (errors.length > 0) {
    throw new CliError(`Invalid agent config: ${errors.join(', ')}`, 1)
  }
}
