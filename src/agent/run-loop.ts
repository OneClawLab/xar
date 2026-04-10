/**
 * Run-loop - Per-agent message processing loop.
 *
 * Concurrency model (per ARCH.md):
 *   - Different agents: concurrent
 *   - Different threads of same agent: concurrent
 *   - Same thread: serial (via per-thread promise chain)
 */

import type { Pai } from 'pai'
import type { AgentConfig } from './types.js'
import type { InboundMessage, OutboundTarget } from '../types.js'
import type { AsyncQueue } from './queue.js'
import { loadAgentConfig } from './config.js'
import { routeMessage, determineThreadId, determineEventType, parseSource, extractConvId } from './router.js'
import { buildContext } from './context.js'
import type { TaskSummaryContext } from './context.js'
import { Deliver } from './deliver.js'
import { IpcChunkWriter } from '../daemon/ipc-chunk-writer.js'
import type { IpcConnection } from '../ipc/types.js'
import type { Logger } from '../logging.js'
import { processTurn } from './turn.js'
import { createSendMessageTool, splitTarget, deliverToPeer, findPeerSource } from './send-message.js'
import { createCreateAgentTaskTool } from './tasks/create-task.js'
import { createCancelAgentTaskTool } from './tasks/cancel-task.js'
import { createSteerAgentTaskTool } from './tasks/steer-task.js'
import { createSpawnAdhocTaskTool } from './tasks/spawn-adhoc-task.js'
import { TaskManager } from './tasks/task-manager.js'
import { MidTurnInjector } from './mid-turn.js'
import { openOrCreateThread } from './thread-lib.js'
import { getDaemonConfig } from '../config.js'
import { join } from 'path'

/**
 * Extract the final assistant text from a list of new messages produced by a turn.
 * Returns the last non-empty assistant text content, or undefined if none.
 */
function extractAssistantText(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text as string)
        .join('')
        .trim()
      if (text) return text
    }
  }
  return undefined
}

export interface RunLoop {
  start(): Promise<void>
  stop(): Promise<void>
}

export class RunLoopImpl implements RunLoop {
  private stopped = false
  private logger: Logger
  /** Per-thread serial lock: messages within the same thread queue behind each other */
  private threadLocks = new Map<string, Promise<void>>()
  /** Track in-flight tasks so stop() can wait for them */
  private inflight = new Set<Promise<void>>()
  /** Per-agent monotonic counter for stream_id uniqueness */
  private streamSeq = 0
  /** Task manager instance (lazy-initialized) */
  private taskManager: TaskManager | null = null

  constructor(
    private agentId: string,
    private queue: AsyncQueue<InboundMessage>,
    // Map of active IPC connections — we pick the best one at message-processing time
    private ipcConnections: Map<string, IpcConnection>,
    private pai: Pai,
    logger?: Logger,
    /**
     * Optional callback for agent-to-agent message routing.
     * Provided by the Daemon so the run-loop doesn't need to know about the
     * full agent registry.
     */
    private sendToAgent?: (agentId: string, message: InboundMessage) => boolean,
    private getRunningAgents?: () => string[],
  ) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      close: async () => {},
    }
  }

  async start(): Promise<void> {
    this.logger.info(`${this.agentId}: Run-loop started`)

    try {
      for await (const msg of this.queue) {
        if (this.stopped) break

        try {
          // Load config once here — processMessage reuses it via parameter
          const config = await loadAgentConfig(this.agentId, getDaemonConfig().theClawHome)
          const threadId = determineThreadId(config, msg.source)

          // Chain onto the per-thread lock (serial within thread, concurrent across threads)
          const prev = this.threadLocks.get(threadId) ?? Promise.resolve()
          const task = prev.then(() => this.processMessage(msg, config)).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err)
            this.logger.error(`${this.agentId}: Error processing message: ${errorMsg}`)
          })
          this.threadLocks.set(threadId, task)
          this.inflight.add(task)
          void task.then(() => { this.inflight.delete(task) })
        } catch (err) {
          // Config load or routing failed for this message — skip it, keep the loop alive
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.logger.error(`${this.agentId}: Error dispatching message (skipped): ${errorMsg}`)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logger.error(`${this.agentId}: Run-loop error: ${errorMsg}`)
    }

    // Wait for all in-flight tasks to finish
    await Promise.all(this.inflight)
    this.logger.info(`${this.agentId}: Run-loop stopped`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.close()
  }

  private getTaskManager(): TaskManager {
    if (!this.taskManager) {
      const theClawHome = getDaemonConfig().theClawHome
      this.taskManager = new TaskManager(this.agentId, theClawHome)
    }
    return this.taskManager
  }

  private getConn(): IpcConnection | undefined {
    // Only return connections that are still open — avoids using a stale
    // WebSocket that was closed after the xar send command disconnected.
    for (const conn of this.ipcConnections.values()) {
      if (conn.isOpen()) return conn
    }
    return undefined
  }

  /**
   * Build OutboundTarget from source address.
   * For external sources, extract channel_id, peer_id, conversation_id.
   * For internal sources, there's no outbound target (agent-to-agent doesn't go through xgw).
   */
  private buildTarget(source: string): OutboundTarget | null {
    const parsed = parseSource(source)
    if (parsed.kind === 'external' && parsed.channel_id && parsed.peer_id && parsed.conversation_id) {
      return {
        channel_id: parsed.channel_id,
        peer_id: parsed.peer_id,
        conversation_id: parsed.conversation_id,
      }
    }
    return null
  }

  /**
   * Generate a unique stream_id: <channel_id>:<conversation_id>:<seq>
   */
  private nextStreamId(target: OutboundTarget): string {
    this.streamSeq++
    return `${target.channel_id}:${target.conversation_id}:${this.streamSeq}`
  }

  /**
   * Wrap sendToAgent to return a Promise<void> as required by create/cancel task tools.
   */
  private makeSendToAgentAsync(): (agentId: string, message: InboundMessage) => Promise<void> {
    return async (targetAgentId: string, message: InboundMessage): Promise<void> => {
      if (this.sendToAgent) {
        const delivered = this.sendToAgent(targetAgentId, message)
        if (!delivered) {
          this.logger.warn(`sendToAgent: agent ${targetAgentId} not running`)
        }
      } else {
        this.logger.warn(`sendToAgent: no sendToAgent callback available`)
      }
    }
  }

  /**
   * Execute a Turn and write results to thread.
   * Returns the new messages produced.
   */
  private async executeTurn(params: {
    msg: InboundMessage
    config: AgentConfig
    threadStore: Awaited<ReturnType<typeof routeMessage>>
    threadId: string
    taskContext?: TaskSummaryContext
    originEventId?: number
    replyTarget?: string
    /** Override the IPC delivery target (used by summary turns to stream to the peer
     *  while keeping msg.source internal for correct role detection). */
    overrideDeliveryTarget?: OutboundTarget
  }): Promise<any[]> {
    const { msg, config, threadStore, threadId, taskContext, originEventId, replyTarget } = params
    const theClawHome = getDaemonConfig().theClawHome
    const providerInfo = await this.pai.getProviderInfo(config.pai.provider)
    const agentDir = join(theClawHome, 'agents', this.agentId)
    const safeThreadId = threadId.replace(/[\\/]/g, '-')
    const sessionFile = join(agentDir, 'sessions', `${safeThreadId}.jsonl`)

    const availableAgents = this.getRunningAgents?.() ?? []
    const { chatInput, eventIds } = await buildContext(
      this.agentId, config, threadStore, msg, threadId, availableAgents, taskContext,
    )
    this.logger.debug(`${this.agentId}: LLM context built`)

    const isInternal = parseSource(msg.source).kind === 'internal'
    const target = params.overrideDeliveryTarget ?? this.buildTarget(msg.source)
    const conn = this.getConn()

    if (!conn && !isInternal) {
      this.logger.warn(`${this.agentId}: No IPC connection available for streaming, processing without streaming`)
    }

    let deliver: Deliver | null = null
    let streamId = ''

    if (target) {
      streamId = this.nextStreamId(target)
      if (conn) {
        deliver = new Deliver(conn, target)
      }
    } else {
      streamId = `internal:${this.agentId}:${this.streamSeq++}`
    }

    const chunkWriter = (conn && target) ? new IpcChunkWriter(conn, streamId) : null
    const convId = extractConvId(msg.source)

    // let bash commands have a way to know current agent id and conversation id
    const extraEnv: Record<string, string> = {
      XAR_AGENT_ID: this.agentId,
      XAR_CONV_ID: convId,
    }

    const sendToAgentAsync = this.makeSendToAgentAsync()
    const taskManager = this.getTaskManager()

    // Determine origin event id and reply target for create_task
    // originEventId comes from the thread's last event (the inbound message we just pushed)
    const currentOriginEventId = originEventId ?? 0
    const currentReplyTarget = replyTarget ?? ''

    const sendMessageTool = createSendMessageTool({
      agentId: this.agentId,
      threadStore,
      ipcConn: conn,
      sendToAgent: this.sendToAgent,
      convId,
      logger: this.logger,
      nextStreamSeq: () => ++this.streamSeq,
    })

    const createAgentTaskTool = createCreateAgentTaskTool({
      taskManager,
      agentId: this.agentId,
      originThreadId: threadId,
      originEventId: currentOriginEventId,
      replyTarget: currentReplyTarget,
      sendToAgent: sendToAgentAsync,
    })

    const cancelAgentTaskTool = createCancelAgentTaskTool({
      taskManager,
      agentId: this.agentId,
      sendToAgent: sendToAgentAsync,
    })

    const steerAgentTaskTool = createSteerAgentTaskTool({
      taskManager,
      agentId: this.agentId,
      sendToAgent: sendToAgentAsync,
    })

    const spawnAdhocTaskTool = createSpawnAdhocTaskTool({
      pai: this.pai,
      provider: config.pai.provider,
      model: config.pai.model,
    })

    // Mid-turn injector for checking new Human messages during tool call loop
    const midTurnInjector = new MidTurnInjector(threadStore)

    const result = await processTurn({
      chatInput,
      pai: this.pai,
      provider: config.pai.provider,
      model: config.pai.model,
      stream: true,
      tokenWriter: chunkWriter,
      sessionFile,
      agentDir,
      threadId,
      eventIds,
      contextWindow: providerInfo.contextWindow,
      maxOutputTokens: providerInfo.maxTokens,
      maxAttempts: config.retry.max_attempts,
      logger: this.logger,
      extraEnv,
      extraTools: [sendMessageTool, createAgentTaskTool, cancelAgentTaskTool, steerAgentTaskTool, spawnAdhocTaskTool],
      midTurnInjector,
      initialLastCheckedEventId: currentOriginEventId,
      callbacks: {
        onCompactStart: (reason) => deliver?.streamCompactStart(streamId, reason),
        onCompactEnd: (before, after) => deliver?.streamCompactEnd(streamId, before, after),
        onCtxUsage: (total, budget, _pct) => {
          const pct = budget > 0 ? Math.round((total / budget) * 100) : 0
          const toK = (n: number) => `${Math.round(n / 1000)}K`
          this.logger.info(`ctx_usage: ${pct}% (${toK(total)}/${toK(budget)}) thread=${threadId}`)
          deliver?.streamCtxUsage(streamId, total, budget)
        },
        onStreamStart: () => deliver?.streamStart(streamId),
        onStreamEnd: () => deliver?.streamEnd(streamId),
        onStreamError: (error) => deliver?.streamError(streamId, error),
        onThinkingDelta: (delta) => deliver?.streamThinking(streamId, delta),
        onToolCall: (tc) => deliver?.streamToolCall(streamId, tc),
        onToolResult: (name, tr) => deliver?.streamToolResult(streamId, name, tr),
      },
    })

    // Write LLM response records to thread
    const threadEvents = result.newMessages.map((m: any) => {
      const serialized = JSON.stringify({
        content: m.content,
        ...(m.tool_calls !== undefined && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id !== undefined && { tool_call_id: m.tool_call_id }),
        ...(m.name !== undefined && { name: m.name }),
      })
      return {
        source: m.role === 'assistant' ? 'self' : `tool:${m.name ?? ''}`,
        type: 'record' as const,
        ...(m.role === 'tool' ? { subtype: 'toolcall' } : {}),
        content: serialized,
      }
    })
    await threadStore.pushBatch(threadEvents)
    this.logger.info(`${this.agentId}: Turn completed: stream=${streamId} records=${threadEvents.length}`)

    return result.newMessages
  }

  private async processMessage(msg: InboundMessage, config: AgentConfig): Promise<void> {
    const target = this.buildTarget(msg.source)
    this.logger.info(`${this.agentId}: Processing message: source=${msg.source}`)

    const parsed = parseSource(msg.source)
    const isInternal = parsed.kind === 'internal'

    let threadStore: Awaited<ReturnType<typeof routeMessage>> | null = null

    try {
      threadStore = await routeMessage(this.agentId, config, msg)
      const threadId = determineThreadId(config, msg.source)
      this.logger.info(`${this.agentId}: Message routed: thread=${threadId}`)

      // ── Worker Announce path ─────────────────────────────────────────────
      // Worker announces use conv_type='agent' (built by announceWorkerResult).
      // Delegation messages use conv_type='task'. Accept both.
      if (isInternal && !msg.reply_to && (parsed.conversation_type === 'task' || parsed.conversation_type === 'agent')) {
        const handled = await this.handleWorkerAnnounce(msg, config, parsed, threadStore)
        if (handled) return
        // No matching task — fall through to normal LLM processing (participant)
      }

      await this.handleNormalTurn(msg, config, parsed, threadStore, threadId, isInternal)

    } catch (err) {
      await this.handleProcessingError(err, msg, target, threadStore)
    }
  }

  /**
   * Handle a worker announce message (internal, no reply_to, conv_type=task).
   * Returns true if the message was fully handled (caller should return),
   * false if no matching task was found and the message should fall through.
   */
  private async handleWorkerAnnounce(
    msg: InboundMessage,
    config: AgentConfig,
    parsed: ReturnType<typeof parseSource>,
    threadStore: Awaited<ReturnType<typeof routeMessage>>,
  ): Promise<boolean> {
    const convId = parsed.conversation_id ?? ''
    const workerAgentId = parsed.sender_agent_id ?? ''
    const failed = msg.content.startsWith('[Task failed]')
    const taskManager = this.getTaskManager()

    // convId is the task_id directly (set by create-task: convId = task.task_id)
    const existingTask = convId ? await taskManager.getTask(convId) : null
    const matchedTaskId = existingTask?.task_id ?? null

    if (!matchedTaskId) {
      this.logger.info(`${this.agentId}: No matching task for announce from ${workerAgentId}, treating as participant message`)
      return false
    }

    const isCancelled = await taskManager.isTaskCancelled(matchedTaskId)
    if (isCancelled) {
      this.logger.info(`${this.agentId}: Discarding announce for cancelled task: ${matchedTaskId}`)
      return true
    }

    await threadStore.push({ source: msg.source, type: 'record', subtype: 'announce', content: msg.content })

    const announceResult = await taskManager.handleAnnounce(matchedTaskId, workerAgentId, msg.content, failed, msg.delegation_id)
    this.logger.info(`${this.agentId}: Worker announce handled: task=${matchedTaskId} worker=${workerAgentId} completed=${announceResult.taskCompleted}`)

    if (announceResult.taskCompleted) {
      const task = announceResult.task
      const subtaskResults = task.subtasks.map((st) => ({
        worker: st.worker,
        instruction: st.instruction,
        ...(st.result !== undefined ? { result: st.result } : {}),
        status: st.status,
      }))

      const replyToValue = task.origin.reply_target.startsWith('peer:') || task.origin.reply_target.startsWith('agent:')
        ? task.origin.reply_target
        : undefined

      const taskContext: TaskSummaryContext = {
        hasPendingTasks: false,
        isSummaryTurn: true,
        taskId: task.task_id,
        subtaskResults,
        replyTarget: task.origin.reply_target,
      }

      this.logger.info(`${this.agentId}: Triggering summary Turn for task: ${matchedTaskId}`)

      // Open the original thread (e.g. peers/alice) so executeTurn and
      // deliverSummaryResult can find the peer's external source address.
      const originThreadStore = await openOrCreateThread(this.agentId, task.origin.thread_id)

      // Resolve the peer's external source so executeTurn can stream to the TUI.
      // We pass it as overrideDeliveryTarget so msg.source stays internal,
      // preserving correct role detection (orchestrator-synthesizing) in buildContext.
      let overrideDeliveryTarget: OutboundTarget | undefined
      if (task.origin.reply_target.startsWith('peer:')) {
        const peerId = task.origin.reply_target.slice('peer:'.length)
        const threadEvents = await originThreadStore.peek({ lastEventId: 0, limit: 2000 }).catch(() => [])
        const externalSource = findPeerSource(threadEvents, peerId)
        this.logger.info(`${this.agentId}: Summary source resolution: peerId=${peerId} threadEvents=${threadEvents.length} externalSource=${externalSource ?? 'not found'}`)
        if (externalSource) {
          const parsed = parseSource(externalSource)
          if (parsed.channel_id && parsed.peer_id && parsed.conversation_id) {
            overrideDeliveryTarget = { channel_id: parsed.channel_id, peer_id: parsed.peer_id, conversation_id: parsed.conversation_id }
          }
        }
      }

      const summaryMsg: InboundMessage = replyToValue !== undefined
        ? { source: msg.source, content: 'All subtasks completed. Please synthesize the results.', reply_to: replyToValue }
        : { source: msg.source, content: 'All subtasks completed. Please synthesize the results.' }

      const newMessages = await this.executeTurn({
        msg: summaryMsg,
        config,
        threadStore: originThreadStore,
        threadId: task.origin.thread_id,
        taskContext,
        originEventId: task.origin.event_id,
        replyTarget: task.origin.reply_target,
        ...(overrideDeliveryTarget !== undefined && { overrideDeliveryTarget }),
      })

      // deliverSummaryResult is only needed when executeTurn couldn't stream directly
      // (e.g. agent-to-agent reply target). When overrideDeliveryTarget is set the
      // summary was already streamed to the peer inside executeTurn, so skip it.
      if (overrideDeliveryTarget === undefined) {
        await this.deliverSummaryResult(newMessages, task.origin.reply_target, originThreadStore)
      }
    }

    return true
  }

  /**
   * Handle a normal turn: determine event type, write to thread, run LLM if needed.
   * Covers both Worker Turn (internal + reply_to) and External (Human) Turn.
   */
  private async handleNormalTurn(
    msg: InboundMessage,
    config: AgentConfig,
    parsed: ReturnType<typeof parseSource>,
    threadStore: Awaited<ReturnType<typeof routeMessage>>,
    threadId: string,
    isInternal: boolean,
  ): Promise<void> {
    const eventType = determineEventType(config, msg)

    await threadStore.push({ source: msg.source, type: eventType, content: msg.content })

    if (eventType === 'record') {
      this.logger.info(`${this.agentId}: Record-only message stored (no LLM): thread=${threadId} source=${msg.source}`)
      return
    }

    // Peek last event id for create_task origin tracking
    let originEventId = 0
    try {
      const recentEvents = await threadStore.peek({ lastEventId: 0, limit: 10000 })
      originEventId = recentEvents[recentEvents.length - 1]?.id ?? 0
    } catch {
      // non-fatal
    }

    const replyTarget = parsed.kind === 'external' && parsed.peer_id
      ? `peer:${parsed.peer_id}`
      : parsed.kind === 'internal' && parsed.sender_agent_id
        ? `agent:${parsed.sender_agent_id}`
        : ''

    // ── Worker Turn: internal message with reply_to ──────────────────────
    if (isInternal && msg.reply_to) {
      const newMessages = await this.executeTurn({ msg, config, threadStore, threadId, originEventId, replyTarget })
      await this.announceWorkerResult(newMessages, msg.reply_to, msg.source, msg.delegation_id)
      return
    }

    // ── External (Human) Turn ────────────────────────────────────────────
    await this.executeTurn({ msg, config, threadStore, threadId, originEventId, replyTarget })
  }

  /**
   * Auto-announce worker Turn result back to the orchestrator.
   */
  private async announceWorkerResult(newMessages: any[], replyTo: string, source: string, delegationId?: string): Promise<void> {
    const assistantText = extractAssistantText(newMessages)
    const [prefix, id] = splitTarget(replyTo)

    if (prefix === 'agent' && this.sendToAgent) {
      const convId = extractConvId(source)
      if (assistantText) {
        const announced = this.sendToAgent(id, {
          source: `internal:agent:${convId}:${this.agentId}`,
          content: assistantText,
          event_type: 'message',
          // Carry delegation_id back so the orchestrator's handleAnnounce can match by id.
          ...(delegationId !== undefined && { delegation_id: delegationId }),
        })
        if (announced) {
          this.logger.info(`${this.agentId}: Worker announce: ${this.agentId} → ${id} (${assistantText.length} chars)`)
        } else {
          this.logger.warn(`${this.agentId}: Worker announce failed: agent ${id} not running`)
        }
      } else {
        this.logger.info(`${this.agentId}: Worker Turn produced no assistant text, skipping announce to ${id}`)
      }
    }
  }

  /**
   * Centralised error handler for processMessage.
   */
  private async handleProcessingError(
    err: unknown,
    msg: InboundMessage,
    target: OutboundTarget | null,
    threadStore: Awaited<ReturnType<typeof routeMessage>> | null,
  ): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err)
    this.logger.error(`${this.agentId}: Message processing failed: ${errorMsg}`)

    if (threadStore) {
      try {
        await threadStore.push({ source: 'self', type: 'record', subtype: 'error', content: errorMsg })
      } catch {
        this.logger.error(`${this.agentId}: Failed to write error record to thread`)
      }
    }

    if (msg.reply_to) {
      const [prefix, id] = splitTarget(msg.reply_to)
      if (prefix === 'agent' && this.sendToAgent) {
        const convId = extractConvId(msg.source)
        const failureNotice = `[Task failed] Agent ${this.agentId} encountered an error: ${errorMsg}`
        const announced = this.sendToAgent(id, {
          source: `internal:task:${convId}:${this.agentId}`,
          content: failureNotice,
          event_type: 'message',
        })
        if (!announced) {
          this.logger.warn(`${this.agentId}: Failed to notify agent ${id} of task failure`)
        }
      }
    }

    try {
      if (target) {
        const conn = this.getConn()
        if (conn) {
          await conn.send({ type: 'stream_error', stream_id: `error:${this.agentId}:${Date.now()}`, error: errorMsg })
        }
      }
    } catch {
      this.logger.error(`${this.agentId}: Failed to send error notification to client`)
    }
  }

  /**
   * Deliver summary Turn result to the reply_target (peer or agent).
   * Used after an orchestrator summary Turn completes.
   */
  private async deliverSummaryResult(
    newMessages: any[],
    replyTarget: string,
    originThreadStore?: Awaited<ReturnType<typeof routeMessage>>,
  ): Promise<void> {
    const assistantText = extractAssistantText(newMessages)
    if (!assistantText) return

    const [prefix, id] = splitTarget(replyTarget)

    if (prefix === 'agent' && this.sendToAgent) {
      const announced = this.sendToAgent(id, {
        source: `internal:agent:${this.agentId}:${this.agentId}`,
        content: assistantText,
        event_type: 'message',
      })
      if (announced) {
        this.logger.info(`${this.agentId}: Summary delivered to agent: ${id} (${assistantText.length} chars)`)
      } else {
        this.logger.warn(`${this.agentId}: Summary delivery failed: agent ${id} not running`)
      }
    } else if (prefix === 'peer') {
      // Deliver to peer via IPC streaming — reuse deliverToPeer from send-message
      const conn = this.getConn()
      if (!conn) {
        this.logger.warn(`${this.agentId}: Summary delivery to peer ${id} skipped: no IPC connection`)
        return
      }
      if (!originThreadStore) {
        this.logger.warn(`${this.agentId}: Summary delivery to peer ${id} skipped: no origin thread store`)
        return
      }
      const result = await deliverToPeer(
        { agentId: this.agentId, threadStore: originThreadStore, ipcConn: conn, sendToAgent: this.sendToAgent, convId: '', logger: this.logger, nextStreamSeq: () => ++this.streamSeq },
        id,
        assistantText,
      )
      if (result.status === 'delivered') {
        this.logger.info(`${this.agentId}: Summary delivered to peer: ${id} (${assistantText.length} chars)`)
      } else {
        this.logger.warn(`${this.agentId}: Summary delivery to peer ${id} failed: ${result.message ?? 'unknown'}`)
      }
    }
  }
}
