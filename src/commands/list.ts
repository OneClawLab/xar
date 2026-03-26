/**
 * List agents command
 */

import { Command } from 'commander'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'

export function createListCommand(): Command {
  return new Command('list')
    .description('List all agents')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const config = getDaemonConfig()
        const agentsDir = join(config.theClawHome, 'agents')

        try {
          const entries = await fs.readdir(agentsDir, { withFileTypes: true })
          const agents = []

          for (const entry of entries) {
            if (entry.isDirectory()) {
              try {
                const configPath = join(agentsDir, entry.name, 'config.json')
                const configData = await fs.readFile(configPath, 'utf-8')
                const agentConfig = JSON.parse(configData)
                agents.push({
                  id: entry.name,
                  kind: agentConfig.kind,
                  status: agentConfig.status || 'unknown',
                })
              } catch {
                // Skip agents with invalid config
              }
            }
          }

          if (options.json) {
            console.log(JSON.stringify(agents))
          } else {
            if (agents.length === 0) {
              console.log('No agents found')
            } else {
              console.log('Agents:')
              for (const agent of agents) {
                console.log(`  ${agent.id} (${agent.kind}): ${agent.status}`)
              }
            }
          }
        } catch {
          if (options.json) {
            console.log(JSON.stringify([]))
          } else {
            console.log('No agents found')
          }
        }
      } catch (err) {
        console.error('Failed to list agents:', err)
        process.exit(1)
      }
    })
}
