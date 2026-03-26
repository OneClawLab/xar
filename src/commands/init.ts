/**
 * Agent initialization command
 */

import { Command } from 'commander'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'
import { CliError } from '../types.js'
import type { AgentConfig } from '../agent/types.js'
import { getThreadLib } from '../agent/thread-lib.js'

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize a new agent')
    .argument('<id>', 'Agent ID')
    .option('--kind <kind>', 'Agent kind (system|user)', 'user')
    .action(async (id: string, options) => {
      try {
        const config = getDaemonConfig()
        const agentDir = join(config.theClawHome, 'agents', id)

        // Check if agent already exists
        try {
          await fs.access(agentDir)
          throw new CliError(`Agent ${id} already exists`, 1)
        } catch (err) {
          if (err instanceof CliError) throw err
          // Directory doesn't exist — good
        }

        // Create directory structure (including threads sub-dirs per SPEC)
        const subdirs = [
          'sessions',
          'memory',
          'threads/peers',
          'threads/sessions',
          'threads/main',
          'workdir',
          'logs',
        ]
        for (const subdir of subdirs) {
          await fs.mkdir(join(agentDir, subdir), { recursive: true })
        }

        // Initialize inbox thread using thread lib (must be new — throws if exists)
        const threadLib = getThreadLib()
        const inboxPath = join(agentDir, 'inbox')
        await threadLib.init(inboxPath)

        // Create IDENTITY.md
        const kind = options.kind === 'system' ? 'system' : 'user'
        await fs.writeFile(
          join(agentDir, 'IDENTITY.md'),
          `# Agent: ${id}\n\n## Role\n${kind === 'system' ? 'System agent for TheClaw v2' : 'User-defined agent'}\n\n## Capabilities\n- Respond to user queries\n- Execute bash commands\n- Maintain conversation context\n\n## Behavior Guidelines\n- Be helpful and respectful\n- Provide clear explanations\n- Ask for clarification when needed\n`,
        )

        // Create USAGE.md
        await fs.writeFile(
          join(agentDir, 'USAGE.md'),
          `# Usage Guide for Agent ${id}\n\n## How to Use\nSend messages to this agent through the xar daemon.\n\n## Examples\n\`\`\`\nxar start ${id}\n\`\`\`\n\n## Configuration\nEdit \`config.json\` to customize agent behavior.\n`,
        )

        // Create config.json (no status field — status is runtime, tracked in daemon memory)
        const agentConfig: AgentConfig = {
          agent_id: id,
          kind,
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
        }

        await fs.writeFile(join(agentDir, 'config.json'), JSON.stringify(agentConfig, null, 2))

        console.log(`Agent ${id} initialized successfully`)
        console.log(`Location: ${agentDir}`)
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to initialize agent:', err)
        process.exit(1)
      }
    })
}
