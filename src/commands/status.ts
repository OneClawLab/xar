/**
 * Agent status command
 */

import { Command } from 'commander'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDaemonConfig } from '../config.js'
import { checkDaemonRunning } from '../daemon/pid.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'
import type { AgentConfig } from '../agent/types.js'

async function getSessionCount(agentDir: string): Promise<number> {
  try {
    const sessionsDir = join(agentDir, 'sessions')
    const entries = await fs.readdir(sessionsDir)
    return entries.filter((e) => e.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

async function getMemoryFiles(agentDir: string): Promise<string[]> {
  try {
    const memDir = join(agentDir, 'memory')
    const entries = await fs.readdir(memDir)
    return entries.filter((e) => e.endsWith('.md'))
  } catch {
    return []
  }
}

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
          const agentDir = join(agentsDir, id)
          const configPath = join(agentDir, 'config.json')
          let agentConfig: AgentConfig
          try {
            const raw = await fs.readFile(configPath, 'utf-8')
            agentConfig = JSON.parse(raw) as AgentConfig
          } catch {
            throw new CliError(`Agent ${id} not found`, 1)
          }

          // Query daemon for runtime status
          let runtimeStatus: Record<string, unknown> = { running: false }
          if (daemonRunning) {
            try {
              const response = await sendIpcMessage(
                { type: 'agent_status', agent_id: id },
                config.ipcPort,
              )
              if (response.type === 'ok' && response.data) {
                runtimeStatus = response.data as Record<string, unknown>
              }
            } catch {
              // IPC unavailable — show static info only
            }
          }

          // Gather disk info
          const sessionCount = await getSessionCount(agentDir)
          const memoryFiles = await getMemoryFiles(agentDir)

          if (options.json) {
            console.log(JSON.stringify({
              agent_id: id,
              kind: agentConfig.kind,
              dir: agentDir,
              daemon_running: daemonRunning,
              pai: agentConfig.pai,
              routing: agentConfig.routing,
              sessions: sessionCount,
              memory_files: memoryFiles,
              ...runtimeStatus,
            }, null, 2))
          } else {
            const running = runtimeStatus['running'] as boolean | undefined
            console.log(`Agent:    ${id} (${agentConfig.kind})`)
            console.log(`Dir:      ${agentDir}`)
            console.log(`Status:   ${running ? 'running' : 'stopped'}`)
            console.log(`Provider: ${agentConfig.pai.provider} / ${agentConfig.pai.model}`)
            console.log(`Routing:  ${agentConfig.routing.mode}/${agentConfig.routing.trigger}`)
            console.log(`Sessions: ${sessionCount} session file(s)`)
            if (memoryFiles.length > 0) {
              console.log(`Memory:   ${memoryFiles.join(', ')}`)
            }
            if (running) {
              const queueDepth = runtimeStatus['queueDepth'] as number | undefined
              const processingCount = runtimeStatus['processingCount'] as number | undefined
              const lastActivity = runtimeStatus['lastActivityAt'] as number | undefined
              if (queueDepth !== undefined) console.log(`Queue:    ${queueDepth} pending`)
              if (processingCount !== undefined) console.log(`Active:   ${processingCount} processing`)
              if (lastActivity) console.log(`Last:     ${new Date(lastActivity).toISOString()}`)
            }
          }
        } else {
          // List all agents with runtime status from daemon
          const runningAgentIds = new Set<string>()
          const runtimeMap = new Map<string, Record<string, unknown>>()

          if (daemonRunning) {
            try {
              const response = await sendIpcMessage({ type: 'daemon_status' }, config.ipcPort)
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
                const agentDir = join(agentsDir, entry.name)
                const raw = await fs.readFile(join(agentDir, 'config.json'), 'utf-8')
                const agentConfig = JSON.parse(raw) as AgentConfig
                const runtime = runtimeMap.get(entry.name)
                agents.push({
                  id: entry.name,
                  kind: agentConfig.kind,
                  provider: `${agentConfig.pai.provider}/${agentConfig.pai.model}`,
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
            console.log(JSON.stringify(agents, null, 2))
          } else {
            if (agents.length === 0) {
              console.log('No agents found')
            } else {
              const colW = Math.max(...agents.map((a) => String(a['id']).length), 4) + 2
              for (const agent of agents) {
                const status = agent['running'] ? 'running' : 'stopped'
                const id = String(agent['id']).padEnd(colW)
                const kind = String(agent['kind']).padEnd(8)
                const provider = String(agent['provider'])
                console.log(`  ${id}${kind}${status.padEnd(10)}${provider}`)
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof CliError) {
          process.stderr.write(err.message + '\n')
          process.exit(err.exitCode)
        }
        process.stderr.write('Failed to get agent status: ' + String(err) + '\n')
        process.exit(1)
      }
    })
}
