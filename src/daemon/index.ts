/**
 * Daemon main entry point
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { createIpcServer } from '../ipc/server.js'
import { writePidFile, deletePidFile } from './pid.js'
import { getDaemonConfig, getSocketPath } from '../config.js'
import type { IpcMessage, InboundMessage } from '../types.js'
import { AsyncQueueImpl } from '../agent/queue.js'
import { RunLoopImpl } from '../agent/run-loop.js'
import type { IpcConnection } from '../ipc/types.js'
import { createDaemonLogger, createAgentLogger } from '../logging.js'
import type { Logger } from '../logging.js'

interface AgentRuntimeState {
  queue: AsyncQueueImpl<InboundMessage>
  runLoop: RunLoopImpl
  runLoopPromise: Promise<void>
  logger: Logger
  startedAt: number
  lastActivityAt: number
  processingCount: number
}

export class Daemon {
  private config = getDaemonConfig()
  private ipcServer = createIpcServer({
    socketPath: getSocketPath(),
    tcpPort: this.config.ipcPort,
  })
  private agents: Map<string, AgentRuntimeState> = new Map()
  private ipcConnections: Map<string, IpcConnection> = new Map()
  private logger: Logger | null = null
  private foreground = false

  async start(foreground = false): Promise<void> {
    this.foreground = foreground
    try {
      this.logger = await createDaemonLogger(undefined, foreground)
      this.logger.info('Daemon starting...')

      await writePidFile(this.config.theClawHome, process.pid)
      this.logger.info(`PID file written: ${process.pid}`)

      await this.ipcServer.start()
      this.logger.info(`IPC Server started on ${getSocketPath()}`)

      this.ipcServer.onMessage(this.handleIpcMessage.bind(this))
      this.ipcServer.onConnection((conn: IpcConnection, connId: string) => {
        this.ipcConnections.set(connId, conn)
        this.logger?.info(`IPC connection established: ${connId} (total: ${this.ipcConnections.size})`)
      })
      this.ipcServer.onDisconnect((connId: string) => {
        this.ipcConnections.delete(connId)
        this.logger?.info(`IPC connection closed: ${connId} (remaining: ${this.ipcConnections.size})`)
      })
      // Load agents with status 'started' — IPC server is up so connections can arrive
      await this.loadAgents()

      process.on('SIGTERM', () => { void this.gracefulShutdown() })
      process.on('SIGINT', () => { void this.gracefulShutdown() })

      this.logger.info('Daemon started successfully')

      // Keep daemon running
      await new Promise(() => { /* never resolves */ })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (this.logger) {
        this.logger.error(`Daemon startup failed: ${errorMsg}`)
        await this.logger.close()
      } else {
        console.error('Daemon startup failed:', err)
      }
      await deletePidFile(this.config.theClawHome)
      process.exit(1)
    }
  }

  private async loadAgents(): Promise<void> {
    // Load the set of agents that were running before daemon restart
    const registryPath = join(this.config.theClawHome, 'started-agents.json')
    let startedIds: string[] = []
    try {
      const raw = await fs.readFile(registryPath, 'utf-8')
      startedIds = JSON.parse(raw) as string[]
    } catch {
      // No registry yet — nothing to auto-start
    }

    for (const agentId of startedIds) {
      try {
        this.logger?.info(`Auto-starting agent: ${agentId}`)
        await this.startAgent(agentId)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        this.logger?.error(`Failed to auto-start agent ${agentId}: ${errorMsg}`)
      }
    }
  }

  /** Persist the set of running agents so daemon restart can restore them. */
  private async saveStartedAgents(): Promise<void> {
    const registryPath = join(this.config.theClawHome, 'started-agents.json')
    const ids = Array.from(this.agents.keys())
    try {
      await fs.mkdir(this.config.theClawHome, { recursive: true })
      await fs.writeFile(registryPath, JSON.stringify(ids), 'utf-8')
    } catch (err) {
      this.logger?.warn(`Failed to save started-agents registry: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  startAgent(agentId: string): Promise<void>
  startAgent(agentId: string, connId?: string): Promise<void>
  async startAgent(agentId: string, connId?: string): Promise<void> {
    if (this.agents.has(agentId)) {
      this.logger?.info(`Agent ${agentId} is already running`)
      return
    }

    // Validate agent exists (config.json must be loadable)
    const { loadAgentConfig } = await import('../agent/config.js')
    await loadAgentConfig(agentId, this.config.theClawHome) // throws CliError if not found

    const agentLogger = await createAgentLogger(agentId, undefined, this.foreground)
    agentLogger.info('Agent starting')

    const queue = new AsyncQueueImpl<InboundMessage>()
    this.ipcServer.registerQueue(agentId, queue)

    // IpcChunkWriter needs a connection to stream tokens to xgw.
    // We use the requesting connection if available, otherwise the first available.
    // The run-loop will use whatever connection is active at message-processing time.
    const conn = (connId ? this.ipcConnections.get(connId) : undefined)
      ?? Array.from(this.ipcConnections.values())[0]

    if (!conn) {
      // No connection yet — create a deferred run-loop that will pick up a connection
      // when the first message arrives. For now, start with a placeholder.
      this.logger?.warn(`No IPC connection available when starting agent ${agentId}, run-loop will use first available connection`)
    }

    const runLoop = new RunLoopImpl(agentId, queue, this.ipcConnections, agentLogger)
    const runLoopPromise = runLoop.start()

    this.agents.set(agentId, {
      queue,
      runLoop,
      runLoopPromise,
      logger: agentLogger,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      processingCount: 0,
    })

    this.logger?.info(`Agent ${agentId} started`)
    agentLogger.info('Agent started successfully')
  }

  private async stopAgent(agentId: string): Promise<void> {
    const state = this.agents.get(agentId)
    if (!state) {
      // Verify agent exists on disk — if not, it's an error
      const { loadAgentConfig } = await import('../agent/config.js')
      await loadAgentConfig(agentId, this.config.theClawHome) // throws CliError if not found
      // Agent exists but is not running — that's fine, nothing to do
      this.logger?.info(`Agent ${agentId} is not running`)
      return
    }

    state.logger.info('Agent stopping')
    await state.runLoop.stop()
    this.agents.delete(agentId)

    // Wait for run-loop to fully drain before closing the logger,
    // otherwise the run-loop's final log write races with stream.end().
    await state.runLoopPromise.catch(() => {})

    this.logger?.info(`Agent ${agentId} stopped`)
    state.logger.info('Agent stopped')
    await state.logger.close()
  }

  private async gracefulShutdown(): Promise<void> {
    this.logger?.info('Daemon shutting down gracefully...')

    const stopPromises = Array.from(this.agents.keys()).map((id) => this.stopAgent(id))
    await Promise.all(stopPromises)

    // Wait for run-loops to drain (max 30s)
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000))
    const allDone = Promise.all(Array.from(this.agents.values()).map((s) => s.runLoopPromise))
    await Promise.race([allDone, timeout])

    await this.ipcServer.stop()
    this.logger?.info('Daemon shutdown complete')
    await this.logger?.close()
    await deletePidFile(this.config.theClawHome)
    process.exit(0)
  }

  private async handleIpcMessage(message: IpcMessage, connId: string): Promise<void> {
    try {
      switch (message.type) {
        case 'inbound_message': {
          if (!message.agent_id || !message.message) {
            this.logger?.warn(`inbound_message malformed: agent_id=${message.agent_id ?? 'missing'} message=${message.message ? 'present' : 'missing'}`)
            break
          }
          const state = this.agents.get(message.agent_id)
          if (state) {
            state.queue.push(message.message)
            state.lastActivityAt = Date.now()
            this.logger?.info(`inbound_message queued: agent=${message.agent_id} source=${message.message.source} queue_depth=${state.queue.size()}`)
          } else {
            this.logger?.warn(`inbound_message dropped: agent=${message.agent_id} not running (source=${message.message?.source ?? 'unknown'})`)
          }
          break
        }

        case 'agent_start': {
          if (!message.agent_id) break
          this.logger?.info(`IPC request: start agent ${message.agent_id}`)
          await this.startAgent(message.agent_id, connId)
          await this.saveStartedAgents()
          await this.ipcServer.sendToConnection(connId, { type: 'ok' })
          break
        }

        case 'agent_stop': {
          if (!message.agent_id) break
          this.logger?.info(`IPC request: stop agent ${message.agent_id}`)
          await this.stopAgent(message.agent_id)
          await this.saveStartedAgents()
          await this.ipcServer.sendToConnection(connId, { type: 'ok' })
          break
        }

        case 'agent_status': {
          if (!message.agent_id) break
          const state = this.agents.get(message.agent_id)
          if (!state) {
            await this.ipcServer.sendToConnection(connId, {
              type: 'ok',
              data: { running: false, agent_id: message.agent_id },
            })
          } else {
            await this.ipcServer.sendToConnection(connId, {
              type: 'ok',
              data: {
                running: true,
                agent_id: message.agent_id,
                startedAt: state.startedAt,
                lastActivityAt: state.lastActivityAt,
                queueDepth: state.queue.size(),
                processingCount: state.processingCount,
              },
            })
          }
          break
        }

        case 'daemon_status': {
          const runningAgents = Array.from(this.agents.entries()).map(([id, s]) => ({
            id,
            startedAt: s.startedAt,
            lastActivityAt: s.lastActivityAt,
            queueDepth: s.queue.size(),
          }))
          await this.ipcServer.sendToConnection(connId, {
            type: 'ok',
            data: {
              pid: process.pid,
              uptime: process.uptime(),
              agents: runningAgents,
            },
          })
          break
        }

        default:
          this.logger?.warn(`Unknown IPC message type: ${message.type}`)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger?.error(`IPC message handling error: ${errorMsg}`)
      await this.ipcServer.sendToConnection(connId, { type: 'error', error: errorMsg })
    }
  }
}

export async function startDaemon(foreground = false): Promise<void> {
  const daemon = new Daemon()
  await daemon.start(foreground)
}
