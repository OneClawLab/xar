/**
 * Agent status command
 */

import { Command } from 'commander'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig, getSocketPath } from '../config.js'
import { checkDaemonRunning } from '../daemon/pid.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'

export function createStatusCommand(): Command {
  return new Command('status')
    .description('Check agent status')
    .argument('[id]', 'Agent ID (optional)')
    .option('--json', 'Output as JSON')
    .action(async (id: string | undefined, options) => {
      try {
        const config = getDaemonConfig()
        const agentsDir = join(config.theClawHome, 'agents')
        const daemonRunning = await checkDaemonRunning(config.theClawHome)

        if (id) {
          // Verify agent exists on disk
          const configPath = join(agentsDir, id, 'config.json')
          try {
            await fs.access(configPath)
          } catch {
            throw new CliError(`Agent ${id} not found`, 1)
          }

          // Query daemon for runtime status
          let runtimeStatus: Record<string, unknown> = { running: false }
          if (daemonRunning) {
            try {
              const response = await sendIpcMessage(
                { type: 'agent_status', agent_id: id },
                getSocketPath(),
                config.ipcPort,
              )
              if (response.type === 'ok' && response.data) {
                runtimeStatus = response.data as Record<string, unknown>
              }
            } catch {
              // IPC unavailable — show static info only
            }
          }

          if (options.json) {
            console.log(JSON.stringify({ agent_id: id, daemon_running: daemonRunning, ...runtimeStatus }))
          } else {
            const running = runtimeStatus['running'] as boolean | undefined
            console.log(`Agent:   ${id}`)
            console.log(`Status:  ${running ? 'running' : 'stopped'}`)
            if (running) {
              const queueDepth = runtimeStatus['queueDepth'] as number | undefined
              const lastActivity = runtimeStatus['lastActivityAt'] as number | undefined
              const processingCount = runtimeStatus['processingCount'] as number | undefined
              if (queueDepth !== undefined) console.log(`Queue:   ${queueDepth} pending`)
              if (processingCount !== undefined) console.log(`Active:  ${processingCount} processing`)
              if (lastActivity) console.log(`Last:    ${new Date(lastActivity).toISOString()}`)
            }
          }
        } else {
          // List all agents with runtime status from daemon
          let runningAgentIds: Set<string> = new Set()
          let runtimeMap: Map<string, Record<string, unknown>> = new Map()

          if (daemonRunning) {
            try {
              const response = await sendIpcMessage({ type: 'daemon_status' }, getSocketPath(), config.ipcPort)
              if (response.type === 'ok' && response.data) {
                const data = response.data as { agents: Array<{ id: string; queueDepth: number; lastActivityAt: number }> }
                for (const a of data.agents) {
                  runningAgentIds.add(a.id)
                  runtimeMap.set(a.id, a as unknown as Record<string, unknown>)
                }
              }
            } catch {
              // IPC unavailable
            }
          }

          // Scan agents directory
          const agents: Array<Record<string, unknown>> = []
          try {
            const entries = await fs.readdir(agentsDir, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              try {
                const configPath = join(agentsDir, entry.name, 'config.json')
                const configData = await fs.readFile(configPath, 'utf-8')
                const agentConfig = JSON.parse(configData) as { kind: string }
                const runtime = runtimeMap.get(entry.name)
                agents.push({
                  id: entry.name,
                  kind: agentConfig.kind,
                  running: runningAgentIds.has(entry.name),
                  ...(runtime ?? {}),
                })
              } catch {
                // Skip agents with invalid config
              }
            }
          } catch {
            // No agents directory
          }

          if (options.json) {
            console.log(JSON.stringify(agents))
          } else {
            if (agents.length === 0) {
              console.log('No agents found')
            } else {
              for (const agent of agents) {
                const status = agent['running'] ? 'running' : 'stopped'
                console.log(`  ${agent['id']} (${agent['kind']}): ${status}`)
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to get agent status:', err)
        process.exit(1)
      }
    })
}
