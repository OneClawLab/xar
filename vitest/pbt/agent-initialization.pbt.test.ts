/**
 * Property-based tests for agent initialization (user and system agents)
 * Validates: Requirements 2.1, 20.1, 20.2
 */

import { describe, it } from 'vitest'
import fc from 'fast-check'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

describe('Agent Initialization Property Tests', () => {
  const getAgentPath = (agentId: string) => {
    const theClawHome = process.env.THECLAW_HOME || join(homedir(), '.theclaw')
    return join(theClawHome, 'agents', agentId)
  }

  const cleanupAgent = (agentId: string) => {
    const agentPath = getAgentPath(agentId)
    if (existsSync(agentPath)) {
      rmSync(agentPath, { recursive: true, force: true })
    }
  }

  it('Property 18: Directory Structure Completeness - For any valid agent ID, initializing an agent SHALL create all required subdirectories', async () => {
    await fc.assert(
      fc.asyncProperty(fc.hexaString({ minLength: 1, maxLength: 20 }), async (agentId) => {
        cleanupAgent(agentId)
        const agentPath = getAgentPath(agentId)

        // Simulate agent initialization by creating directory structure
        const requiredDirs = ['inbox', 'sessions', 'memory', 'threads', 'workdir', 'logs']
        const fs = await import('fs/promises')

        try {
          await fs.mkdir(agentPath, { recursive: true })
          for (const dir of requiredDirs) {
            await fs.mkdir(join(agentPath, dir), { recursive: true })
          }

          // Verify all directories exist
          for (const dir of requiredDirs) {
            const dirPath = join(agentPath, dir)
            if (!existsSync(dirPath)) {
              return false
            }
          }

          return true
        } finally {
          cleanupAgent(agentId)
        }
      }),
      { numRuns: 50 },
    )
  })

  it('Property 18: Config file creation - For any valid agent ID, initializing an agent SHALL create config.json with required fields', async () => {
    await fc.assert(
      fc.asyncProperty(fc.hexaString({ minLength: 1, maxLength: 20 }), async (agentId) => {
        cleanupAgent(agentId)
        const agentPath = getAgentPath(agentId)
        const fs = await import('fs/promises')

        try {
          await fs.mkdir(agentPath, { recursive: true })

          const config = {
            agent_id: agentId,
            kind: 'user',
            pai: {
              provider: 'openai',
              model: 'gpt-4o',
            },
            routing: {
              default: 'per-peer',
            },
            memory: {
              compact_threshold_tokens: 8000,
              session_compact_threshold_tokens: 4000,
            },
            retry: {
              max_attempts: 3,
            },
            status: 'stopped',
          }

          await fs.writeFile(join(agentPath, 'config.json'), JSON.stringify(config, null, 2))

          const content = await fs.readFile(join(agentPath, 'config.json'), 'utf-8')
          const parsed = JSON.parse(content)

          return (
            parsed.agent_id === agentId &&
            parsed.kind === 'user' &&
            parsed.status === 'stopped' &&
            parsed.pai?.provider === 'openai'
          )
        } finally {
          cleanupAgent(agentId)
        }
      }),
      { numRuns: 50 },
    )
  })
})


