# Design Document: xar Daemon

## Overview

xar is a background daemon that manages agent lifecycle, routes inbound messages to per-agent queues, and orchestrates LLM interactions with streaming token delivery. The architecture is built on three core pillars:

1. **Per-agent message queues**: Each agent has an independent in-memory AsyncQueue that buffers inbound messages
2. **Run-loop model**: Each agent runs a persistent async loop that consumes messages, processes them through the LLM, and persists results to threads
3. **Streaming-first delivery**: LLM tokens are streamed directly to xgw via IPC without batching

The daemon manages multiple agents concurrently while ensuring each agent processes messages serially, providing natural thread safety without explicit locking.

## Architecture

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         xar Daemon                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              IPC Server (WebSocket)                      │  │
│  │  Unix socket: ~/.theclaw/xar.sock                        │  │
│  │  TCP fallback: 127.0.0.1:XAR_IPC_PORT                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓ inbound_message                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Message Router (by agent_id)                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓                                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Agent-admin Queue  │  Agent-warden Queue  │  ...        │  │
│  │  [msg1, msg2, ...]  │  [msg3, ...]        │             │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓                      ↓                              │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ Run-loop(admin)  │  │Run-loop(warden)  │  ...               │
│  │ for await msg    │  │ for await msg    │                    │
│  │ processMessage() │  │ processMessage() │                    │
│  └──────────────────┘  └──────────────────┘                    │
│           ↓                      ↓                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Thread Library (ThreadStore)                            │  │
│  │  ~/.theclaw/agents/<id>/inbox/                           │  │
│  │  ~/.theclaw/agents/<id>/threads/                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓                                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  pai Library (LLM Chat)                                  │  │
│  │  Streaming tokens → IpcChunkWriter                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓ stream_token, stream_thinking, stream_end          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  IPC Client (to xgw)                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│           ↓                                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Memory Processor (async)                                │  │
│  │  Peer memory, agent memory, session compression          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Cron Scheduler (internal)                               │  │
│  │  Periodic memory updates, cleanup tasks                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|-----------------|
| **IPC Server** | Accept WebSocket connections, route inbound messages to agent queues, send streaming tokens back to xgw |
| **Message Router** | Distribute inbound messages to correct agent queue based on agent_id |
| **Agent Queue** | Buffer messages in FIFO order, provide async iteration interface |
| **Run-loop** | Consume messages from queue, orchestrate message processing, manage LLM calls |
| **Router** | Determine target thread based on agent routing config and message source |
| **Context Builder** | Assemble LLM context from thread history, memory, and system prompt |
| **pai Integration** | Call LLM with streaming support, handle tool execution |
| **IpcChunkWriter** | Implement Writable interface, send tokens as IPC messages |
| **Memory Processor** | Asynchronously update peer/agent memory, trigger compression |
| **Cron Scheduler** | Execute periodic tasks (memory updates, cleanup) |

## Components and Interfaces

### 1. IPC Server

**File**: `src/daemon/server.ts`

```typescript
interface IpcServer {
  start(socketPath: string): Promise<void>
  stop(): Promise<void>
  broadcast(message: IpcMessage): Promise<void>
  sendToConnection(connId: string, message: IpcMessage): Promise<void>
}

interface IpcMessage {
  type: 'inbound_message' | 'stream_start' | 'stream_token' | 'stream_thinking' | 
        'stream_end' | 'stream_error' | 'agent_start' | 'agent_stop' | 'ok' | 'error'
  agent_id?: string
  message?: InboundMessage
  reply_context?: ReplyContext
  session_id?: string
  token?: string
  delta?: string
  data?: unknown
  error?: string
}

interface InboundMessage {
  source: string
  content: string
  reply_context: ReplyContext
}

interface ReplyContext {
  channel_type: string
  channel_id: string
  session_type: string
  session_id: string
  peer_id: string
  ipc_conn_id?: string
}
```

**Responsibilities**:
- Listen on Unix socket (primary) or TCP (fallback)
- Accept WebSocket connections
- Route `inbound_message` to agent queues
- Send streaming messages back to xgw
- Handle connection lifecycle (connect, disconnect, error)

### 2. Message Queue (AsyncQueue)

**File**: `src/agent/queue.ts`

```typescript
interface AsyncQueue<T> {
  push(item: T): void
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<T>
}

class AsyncQueueImpl<T> implements AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((item: T) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter(item)
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    this.waiters.forEach(w => w(null as any))
    this.waiters = []
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.closed || this.items.length > 0) {
      if (this.items.length > 0) {
        yield this.items.shift()!
      } else if (!this.closed) {
        await new Promise(resolve => this.waiters.push(() => resolve(undefined)))
      }
    }
  }
}
```

**Responsibilities**:
- Store messages in FIFO order
- Provide async iteration for run-loop consumption
- Support graceful shutdown via `close()`

### 3. Run-loop

**File**: `src/agent/run-loop.ts`

```typescript
interface RunLoop {
  start(agentId: string, queue: AsyncQueue<InboundMessage>): Promise<void>
  stop(): Promise<void>
}

async function runLoop(agentId: string, queue: AsyncQueue<InboundMessage>) {
  for await (const msg of queue) {
    try {
      await processMessage(agentId, msg)
    } catch (err) {
      await writeErrorRecord(agentId, msg, err)
    }
  }
}

async function processMessage(agentId: string, msg: InboundMessage) {
  // 1. Route to target thread
  const threadStore = await router.route(agentId, msg)
  
  // 2. Write inbound message to thread
  await threadStore.push({
    source: msg.source,
    type: 'message',
    content: JSON.stringify({ content: msg.content, reply_context: msg.reply_context }),
  })
  
  // 3. Build LLM context
  const ctx = await contextBuilder.build(agentId, threadStore, msg)
  
  // 4. Stream LLM response
  const ipcWriter = new IpcChunkWriter(msg.reply_context)
  await deliver.streamStart(msg.reply_context)
  
  for await (const event of pai.chat(ctx.input, ctx.config, ipcWriter, tools, signal)) {
    if (event.type === 'thinking_delta') {
      await deliver.streamThinking(msg.reply_context, event.delta)
    }
    if (event.type === 'chat_end') {
      // Write responses to thread
      await threadStore.pushBatch(event.newMessages.map(m => ({
        source: m.role === 'assistant' ? 'self' : `tool:${m.name ?? ''}`,
        type: 'record' as const,
        subtype: m.role === 'tool' ? 'toolcall' : undefined,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })))
      
      // Trigger async memory update
      await memory.scheduleUpdate(agentId, threadStore, event)
    }
  }
  
  await deliver.streamEnd(msg.reply_context)
}
```

**Responsibilities**:
- Consume messages from queue
- Orchestrate message processing pipeline
- Handle errors and retries
- Emit completion events for memory updates

### 4. Router

**File**: `src/agent/router.ts`

```typescript
interface Router {
  route(agentId: string, msg: InboundMessage): Promise<ThreadStore>
}

class RouterImpl implements Router {
  async route(agentId: string, msg: InboundMessage): Promise<ThreadStore> {
    const config = await loadAgentConfig(agentId)
    const routingMode = config.routing.default // 'per-peer' | 'per-session' | 'per-agent'
    
    let threadPath: string
    
    if (routingMode === 'per-peer') {
      const peerId = msg.reply_context.peer_id
      threadPath = `~/.theclaw/agents/${agentId}/threads/peers/${peerId}`
    } else if (routingMode === 'per-session') {
      const sessionId = msg.reply_context.session_id
      threadPath = `~/.theclaw/agents/${agentId}/threads/sessions/${sessionId}`
    } else {
      threadPath = `~/.theclaw/agents/${agentId}/threads/main`
    }
    
    return await threadLib.open(threadPath)
  }
}
```

**Responsibilities**:
- Determine target thread based on routing configuration
- Open or create thread via ThreadLib
- Return ThreadStore for message processing

### 5. Context Builder

**File**: `src/agent/context.ts`

```typescript
interface ContextBuilder {
  build(agentId: string, threadStore: ThreadStore, msg: InboundMessage): Promise<LlmContext>
}

interface LlmContext {
  input: ChatInput
  config: ChatConfig
}

class ContextBuilderImpl implements ContextBuilder {
  async build(agentId: string, threadStore: ThreadStore, msg: InboundMessage): Promise<LlmContext> {
    // 1. Load agent config and identity
    const config = await loadAgentConfig(agentId)
    const identity = await readFile(`~/.theclaw/agents/${agentId}/IDENTITY.md`)
    
    // 2. Peek recent thread events
    const events = await threadStore.peek({ lastEventId: 0, limit: 100 })
    
    // 3. Load memory files
    const agentMemory = await readFile(`~/.theclaw/agents/${agentId}/memory/agent.md`).catch(() => '')
    const peerId = msg.reply_context.peer_id
    const peerMemory = await readFile(`~/.theclaw/agents/${agentId}/memory/user-${peerId}.md`).catch(() => '')
    
    // 4. Check session token count
    const sessionTokens = estimateTokens(events)
    if (sessionTokens > config.memory.session_compact_threshold_tokens) {
      // Trigger session compression
      const compressed = await compressSession(events, config)
      await writeFile(`~/.theclaw/agents/${agentId}/memory/thread-${slugify(threadStore.path)}.md`, compressed)
    }
    
    // 5. Assemble context
    const systemPrompt = `${identity}\n\n## Agent Memory\n${agentMemory}\n\n## Peer Memory\n${peerMemory}`
    const messages = convertEventsToMessages(events)
    
    return {
      input: { systemPrompt, messages },
      config: { provider: config.pai.provider, model: config.pai.model },
    }
  }
}
```

**Responsibilities**:
- Read thread history via ThreadStore.peek()
- Load memory files from disk
- Estimate token counts
- Trigger session compression if needed
- Assemble system prompt and message history
- Return LLM-ready context

### 6. IpcChunkWriter

**File**: `src/daemon/ipc-chunk-writer.ts`

```typescript
class IpcChunkWriter extends Writable {
  constructor(private replyContext: ReplyContext, private ipcServer: IpcServer) {
    super()
  }

  _write(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void) {
    const token = chunk.toString('utf-8')
    this.ipcServer.sendToConnection(this.replyContext.ipc_conn_id!, {
      type: 'stream_token',
      session_id: this.replyContext.session_id,
      token,
    }).catch(err => callback(err))
      .then(() => callback())
  }
}
```

**Responsibilities**:
- Implement Node.js Writable interface
- Convert token chunks to IPC messages
- Send tokens to xgw via IPC

### 7. Memory Processor

**File**: `src/agent/memory.ts`

```typescript
interface MemoryProcessor {
  scheduleUpdate(agentId: string, threadStore: ThreadStore, event: ChatEndEvent): Promise<void>
}

class MemoryProcessorImpl implements MemoryProcessor {
  async scheduleUpdate(agentId: string, threadStore: ThreadStore, event: ChatEndEvent) {
    // Fire and forget - don't block run-loop
    setImmediate(async () => {
      try {
        const config = await loadAgentConfig(agentId)
        const peerId = event.replyContext.peer_id
        
        // Estimate peer memory size
        const peerMemoryPath = `~/.theclaw/agents/${agentId}/memory/user-${peerId}.md`
        const peerMemory = await readFile(peerMemoryPath).catch(() => '')
        const peerTokens = estimateTokens(peerMemory)
        
        if (peerTokens > config.memory.compact_threshold_tokens) {
          // Compress peer memory
          const compressed = await compressMemory(peerMemory, event.newMessages, config)
          await writeFile(peerMemoryPath, compressed)
        }
      } catch (err) {
        logger.error(`Memory update failed for agent ${agentId}:`, err)
      }
    })
  }
}
```

**Responsibilities**:
- Asynchronously update memory files
- Trigger compression when thresholds exceeded
- Log errors without affecting run-loop

### 8. Daemon Manager

**File**: `src/daemon/index.ts`

```typescript
interface Daemon {
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<DaemonStatus>
}

interface DaemonStatus {
  pid: number
  uptime: number
  agentsRegistered: number
  agentsRunning: number
}

class DaemonImpl implements Daemon {
  private runLoops: Map<string, RunLoop> = new Map()
  private ipcServer: IpcServer
  private scheduler: CronScheduler

  async start() {
    // 1. Write PID file
    await writePidFile()
    
    // 2. Start IPC server
    this.ipcServer = createIpcServer()
    await this.ipcServer.start()
    
    // 3. Load and start agents
    const agents = await loadAgents()
    for (const agent of agents) {
      if (agent.status === 'started') {
        await this.startAgent(agent.id)
      }
    }
    
    // 4. Start cron scheduler
    this.scheduler = new CronScheduler()
    this.scheduler.start()
  }

  async stop() {
    // 1. Stop accepting new messages
    await this.ipcServer.stop()
    
    // 2. Wait for run-loops to complete
    for (const runLoop of this.runLoops.values()) {
      await runLoop.stop()
    }
    
    // 3. Stop scheduler
    this.scheduler.stop()
    
    // 4. Clean up PID file
    await deletePidFile()
  }

  private async startAgent(agentId: string) {
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl()
    
    this.runLoops.set(agentId, runLoop)
    runLoop.start(agentId, queue)
    
    // Register queue with IPC server for message routing
    this.ipcServer.registerQueue(agentId, queue)
  }
}
```

**Responsibilities**:
- Manage daemon lifecycle
- Start/stop IPC server
- Load and start agents
- Manage run-loops
- Handle graceful shutdown

## Data Models

### Agent Configuration

```typescript
interface AgentConfig {
  agent_id: string
  kind: 'system' | 'user'
  status: 'stopped' | 'started'
  pai: {
    provider: string
    model: string
  }
  routing: {
    default: 'per-peer' | 'per-session' | 'per-agent'
  }
  memory: {
    compact_threshold_tokens: number
    session_compact_threshold_tokens: number
  }
  retry: {
    max_attempts: number
  }
}
```

### Thread Event

```typescript
interface ThreadEvent {
  id: number
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
  timestamp: number
}

interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}
```

### LLM Message

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ToolCall[]
  name?: string
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
```

## Error Handling

### Run-loop Error Strategy

| Error Type | Handling |
|-----------|----------|
| LLM transient (network, timeout, rate limit) | Retry with exponential backoff up to `max_attempts` |
| LLM permanent (auth, policy) | Write error record to thread, continue |
| Thread operation failure | Log error, write error record, continue |
| Memory update failure | Log error, don't block run-loop |
| IPC connection loss | Log error, continue processing (responses lost but thread has record) |

### Daemon Error Strategy

| Error Type | Handling |
|-----------|----------|
| IPC Server startup failure | Log error, exit with code 1 |
| Agent config load failure | Log error, skip agent, continue |
| Uncaught exception | Log error, exit with code 1, cleanup PID file |

## Testing Strategy

### Unit Testing

Unit tests verify specific examples and edge cases:

- **Message Queue**: Test push/pop, async iteration, close behavior
- **Router**: Test routing logic for different modes (per-peer, per-session, per-agent)
- **Context Builder**: Test context assembly with various thread histories and memory states
- **IpcChunkWriter**: Test token serialization and IPC message format
- **Error Handling**: Test retry logic, error record creation, graceful degradation

### Property-Based Testing

Property-based tests verify universal properties across generated inputs:

- **Message Queue FIFO**: For any sequence of messages, consuming in order preserves FIFO property
- **Router Determinism**: For any agent config and message, routing always produces same thread path
- **Context Idempotence**: Building context twice from same thread state produces equivalent context
- **Token Streaming**: For any LLM response, streaming tokens reconstruct original response
- **Memory Compression Round-trip**: Compressing then decompressing memory preserves semantic content
- **Error Recovery**: After error, run-loop continues processing subsequent messages

## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property 1: Message Queue FIFO Ordering

*For any* sequence of messages pushed to an agent's queue, consuming them via async iteration SHALL return them in the same order they were pushed.

**Validates: Requirements 5.2, 5.3**

### Property 2: Router Determinism

*For any* agent configuration and inbound message, the Router SHALL always produce the same target thread path when given identical inputs.

**Validates: Requirements 6.1**

### Property 3: Agent Status Consistency

*For any* agent, when the Daemon launches a run-loop, the agent status in `config.json` SHALL be updated to `started`, and when the Daemon stops a run-loop, the status SHALL be updated to `stopped`.

**Validates: Requirements 3.2, 3.3, 3.5, 3.6**

### Property 4: Message Persistence Round-trip

*For any* inbound message written to a thread via ThreadStore.push(), reading the thread via ThreadStore.peek() SHALL return an event with equivalent content and metadata.

**Validates: Requirements 6.3, 6.4**

### Property 5: Context Assembly Completeness

*For any* thread history and memory state, the Context Builder SHALL assemble a context that includes system prompt from IDENTITY.md, thread history, and all available memory files.

**Validates: Requirements 7.2, 7.3**

### Property 6: Token Streaming Reconstruction

*For any* LLM response, the sequence of `stream_token` IPC messages sent by IpcChunkWriter SHALL reconstruct the original token sequence when concatenated.

**Validates: Requirements 8.2**

### Property 7: Batch Message Atomicity

*For any* batch of messages written to a thread via ThreadStore.pushBatch(), all messages SHALL be persisted atomically or none at all.

**Validates: Requirements 10.3**

### Property 8: Memory Compression Idempotence

*For any* peer memory state, compressing it twice SHALL produce equivalent compressed output (modulo timestamp differences).

**Validates: Requirements 11.1, 11.3**

### Property 9: Run-loop Continuation After Error

*For any* sequence of messages where one message causes an LLM error, the run-loop SHALL continue processing subsequent messages without blocking.

**Validates: Requirements 13.3**

### Property 10: Retry Exponential Backoff

*For any* transient LLM failure, the run-loop SHALL retry with exponential backoff intervals, with total retry count not exceeding `retry.max_attempts`.

**Validates: Requirements 13.1**

### Property 11: Message Format Validity

*For any* inbound message sent via IPC, the message format SHALL include all required fields: type, agent_id, message (with source, content, reply_context).

**Validates: Requirements 14.3**

### Property 12: Streaming Message Format Validity

*For any* streaming token sent via IPC, the message format SHALL include all required fields: type, session_id, token.

**Validates: Requirements 14.4**

### Property 13: Log Entry Presence

*For any* daemon lifecycle event (start, stop, error), a corresponding log entry SHALL be written to `~/.theclaw/logs/xar.log`.

**Validates: Requirements 15.1, 15.5**

### Property 14: Configuration Validation

*For any* agent configuration loaded from `config.json`, the Daemon SHALL validate that all required fields are present and have valid types.

**Validates: Requirements 17.2, 17.4**

### Property 15: Environment Variable Override

*For any* environment variable set (THECLAW_HOME, XAR_IPC_PORT, XAR_LOG_LEVEL), the System SHALL use the environment variable value instead of defaults.

**Validates: Requirements 18.1, 18.2, 18.3**

### Property 16: Exit Code Correctness

*For any* command execution, the exit code SHALL be 0 for success, 1 for runtime errors, and 2 for usage errors.

**Validates: Requirements 19.1, 19.2, 19.3**

### Property 17: System Agent Initialization

*For any* system agent ID (admin, warden, maintainer, evolver), initializing it SHALL create the agent with kind set to `system` in `config.json`.

**Validates: Requirements 20.1, 20.2**

### Property 18: Directory Structure Completeness

*For any* agent initialization, all required subdirectories (inbox, sessions, memory, threads, workdir, logs) SHALL be created.

**Validates: Requirements 2.1**

### Property 19: Agent Status Initialization

*For any* agent initialization, the agent status in `config.json` SHALL be set to `stopped`.

**Validates: Requirements 2.4**

### Property 20: Graceful Shutdown Completion

*For any* running daemon receiving SIGTERM, all in-flight message processing SHALL complete before the daemon exits, and PID and socket files SHALL be deleted.

**Validates: Requirements 1.4**
