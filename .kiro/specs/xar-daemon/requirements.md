# Requirements Document: xar Daemon

## Introduction

xar is the core runtime daemon for TheClaw v2 architecture, responsible for agent lifecycle management, message scheduling, LLM invocation, and outbound delivery. It operates as a pure CLI/Daemon module that manages per-agent message queues, coordinates with the thread library for event persistence, and streams LLM responses through IPC to the xgw gateway.

## Glossary

- **Agent**: An autonomous entity with identity, configuration, and persistent state stored in `~/.theclaw/agents/<id>/`
- **Run-loop**: Per-agent async message processing loop that continuously consumes from an in-memory queue
- **IPC**: Inter-process communication via WebSocket over Unix socket (or TCP fallback)
- **Thread**: Persistent event log managed by thread library, storing messages and LLM responses
- **Memory**: Multi-level persistent storage (agent-level, peer-level, session-level) for context compression
- **Streaming**: Real-time token delivery from LLM through IPC to xgw without batching
- **Routing**: Mechanism to map inbound messages to target threads based on agent configuration
- **Daemon**: Background process managing all agents and IPC server
- **ThreadStore**: Per-thread operation object providing push/peek/init interfaces
- **ThreadLib**: Factory interface for opening, initializing, and destroying threads
- **pai**: LLM library providing chat interface with streaming support
- **xgw**: Gateway service that receives streaming tokens from xar via IPC

## Requirements

### Requirement 1: Daemon Lifecycle Management

**User Story:** As a system operator, I want to start, stop, and monitor the xar daemon, so that I can manage the agent runtime infrastructure.

#### Acceptance Criteria

1. WHEN `xar daemon start` is executed, THE Daemon SHALL fork a background process, write its PID to `~/.theclaw/xar.pid`, and start an IPC Server listening on `~/.theclaw/xar.sock`
2. WHEN the Daemon starts, THE Daemon SHALL load all agents with status `started` from `~/.theclaw/agents/*/config.json` and launch a run-loop for each
3. WHEN the Daemon starts, THE Daemon SHALL initialize the internal cron scheduler for periodic tasks
4. WHEN `xar daemon stop` is executed, THE Daemon SHALL receive SIGTERM and gracefully shutdown by stopping new message acceptance, waiting for all run-loops to complete current message processing, closing the IPC Server, and deleting PID and socket files
5. WHEN `xar daemon stop` is executed and the Daemon does not respond within 30 seconds, THE Daemon SHALL be forcefully terminated with SIGKILL
6. WHEN `xar daemon status` is executed, THE Daemon SHALL return current PID, uptime, count of registered agents, and count of running agents
7. IF the Daemon is already running when `xar daemon start` is executed, THEN THE Daemon SHALL report an error and exit with code 1
8. IF the Daemon is not running when `xar daemon stop` is executed, THEN THE Daemon SHALL report an error and exit with code 1

### Requirement 2: Agent Initialization

**User Story:** As a system operator, I want to initialize new agents with default configuration, so that I can register them in the system.

#### Acceptance Criteria

1. WHEN `xar init <id>` is executed, THE System SHALL create directory structure at `~/.theclaw/agents/<id>/` with subdirectories: `inbox`, `sessions`, `memory`, `threads`, `workdir`, `logs`
2. WHEN `xar init <id>` is executed, THE System SHALL generate default `IDENTITY.md`, `USAGE.md`, and `config.json` files
3. WHEN `xar init <id>` is executed, THE System SHALL initialize an inbox thread via ThreadLib.init() at `~/.theclaw/agents/<id>/inbox/`
4. WHEN `xar init <id>` is executed, THE System SHALL set agent status to `stopped` in `config.json`
5. IF an agent with the same `<id>` already exists, THEN THE System SHALL report an error and exit with code 1
6. WHERE `--kind system|user` option is provided, THE System SHALL set the agent kind accordingly in `config.json`

### Requirement 3: Agent Lifecycle Control

**User Story:** As a system operator, I want to start and stop individual agents, so that I can control which agents are active.

#### Acceptance Criteria

1. WHEN `xar start <id>` is executed, THE System SHALL send an `agent_start` message via IPC to the Daemon
2. WHEN the Daemon receives `agent_start` for an agent, THE Daemon SHALL launch a run-loop for that agent if not already running
3. WHEN the Daemon launches a run-loop, THE Daemon SHALL update agent status to `started` in `config.json`
4. WHEN `xar stop <id>` is executed, THE System SHALL send an `agent_stop` message via IPC to the Daemon
5. WHEN the Daemon receives `agent_stop` for an agent, THE Daemon SHALL stop accepting new messages to that agent's queue and wait for current message processing to complete
6. WHEN the Daemon stops a run-loop, THE Daemon SHALL update agent status to `stopped` in `config.json`
7. IF the Daemon is not running when `xar start <id>` is executed, THEN THE System SHALL report an error and exit with code 1

### Requirement 4: Agent Status and Discovery

**User Story:** As a system operator, I want to query agent status and list all agents, so that I can monitor system state.

#### Acceptance Criteria

1. WHEN `xar status` is executed without agent ID, THE System SHALL display status summary for all agents (ID, status, inbox backlog count, last activity time)
2. WHEN `xar status <id>` is executed, THE System SHALL display detailed status for the specified agent (status, inbox backlog, last activity, current processing message count)
3. WHEN `xar status` is executed with `--json` flag, THE System SHALL output status in JSON format
4. WHEN `xar list` is executed, THE System SHALL enumerate all initialized agents from `~/.theclaw/agents/` directory
5. WHEN `xar list` is executed with `--json` flag, THE System SHALL output agent list in JSON format

### Requirement 5: Inbound Message Routing and Queuing

**User Story:** As the xgw gateway, I want to send messages to agents through IPC, so that external messages reach the correct agent for processing.

#### Acceptance Criteria

1. WHEN xgw sends an `inbound_message` via IPC with `agent_id`, `source`, `content`, and `reply_context`, THE IPC Server SHALL route the message to the corresponding agent's queue
2. WHEN a message is routed to an agent's queue, THE Message Queue SHALL store it in FIFO order
3. WHEN the run-loop is consuming messages, THE Run-loop SHALL process messages sequentially from the queue
4. IF an agent's queue receives a message but the agent is not running, THE Message Queue SHALL buffer the message until the agent starts
5. WHEN an agent stops, THE Message Queue SHALL stop accepting new messages and discard buffered messages

### Requirement 6: Message Processing and Thread Integration

**User Story:** As the run-loop, I want to process inbound messages and persist them to threads, so that all interactions are recorded.

#### Acceptance Criteria

1. WHEN the run-loop receives an inbound message, THE Router SHALL determine the target thread based on agent routing configuration and message source
2. WHEN the Router determines the target thread, THE Run-loop SHALL open or create the thread via ThreadLib.open()
3. WHEN the Run-loop opens a thread, THE Run-loop SHALL write the inbound message as a ThreadEventInput to the thread via ThreadStore.push()
4. WHEN a message is written to a thread, THE Thread SHALL persist the event and return a ThreadEvent with assigned ID
5. WHEN the Run-loop completes processing a message, THE Run-loop SHALL continue to the next message in the queue without blocking

### Requirement 7: LLM Context Construction

**User Story:** As the run-loop, I want to construct LLM context from thread history and memory, so that the LLM has necessary context for generating responses.

#### Acceptance Criteria

1. WHEN the Run-loop prepares to call the LLM, THE Context Builder SHALL read recent events from the target thread via ThreadStore.peek()
2. WHEN the Context Builder reads thread events, THE Context Builder SHALL load relevant memory files (agent-level, peer-level, session-level) from `~/.theclaw/agents/<id>/memory/`
3. WHEN the Context Builder constructs context, THE Context Builder SHALL assemble system prompt from `IDENTITY.md`, thread history, and memory into a pai-compatible input format
4. WHEN the Context Builder estimates session token count, THE Context Builder SHALL check if it exceeds `session_compact_threshold_tokens` from agent config
5. IF session token count exceeds threshold, THEN THE Context Builder SHALL trigger session-level memory compression before constructing final context

### Requirement 8: LLM Streaming and Token Delivery

**User Story:** As the run-loop, I want to stream LLM tokens to xgw in real-time, so that users see responses as they are generated.

#### Acceptance Criteria

1. WHEN the Run-loop calls pai.chat(), THE Run-loop SHALL pass an IpcChunkWriter that implements the Writable interface
2. WHEN pai.chat() generates tokens, THE IpcChunkWriter SHALL send each token as a `stream_token` IPC message to xgw
3. WHEN pai.chat() starts generating, THE Run-loop SHALL send a `stream_start` IPC message with reply_context and session_id
4. WHEN pai.chat() completes, THE Run-loop SHALL send a `stream_end` IPC message with session_id
5. IF pai.chat() encounters an error, THEN THE Run-loop SHALL send a `stream_error` IPC message with error details
6. WHERE pai.chat() generates thinking tokens, THE Run-loop SHALL send `stream_thinking` IPC messages with thinking deltas

### Requirement 9: Tool Execution

**User Story:** As the run-loop, I want to execute bash commands through tool calls, so that agents can perform system operations.

#### Acceptance Criteria

1. WHEN the Run-loop calls pai.chat(), THE Run-loop SHALL pass a bash_exec tool created via pai.createBashExecTool()
2. WHEN pai.chat() generates a tool call for bash_exec, THE pai library SHALL execute the command and return results
3. WHEN a tool call completes, THE Run-loop SHALL write the tool result to the thread as a ThreadEventInput with type `record` and subtype `toolcall`

### Requirement 10: LLM Response Persistence

**User Story:** As the run-loop, I want to persist LLM responses to threads, so that all interactions are recorded for future reference.

#### Acceptance Criteria

1. WHEN pai.chat() completes and returns messages, THE Run-loop SHALL convert each message to ThreadEventInput format
2. WHEN converting messages, THE Run-loop SHALL set source to `self` for assistant messages and `tool:<name>` for tool messages
3. WHEN the Run-loop has converted all messages, THE Run-loop SHALL write them to the thread via ThreadStore.pushBatch()
4. WHEN messages are written to the thread, THE Thread SHALL persist all events atomically

### Requirement 11: Session-Level Memory Compression

**User Story:** As the context builder, I want to compress session history when it grows too large, so that LLM context remains manageable.

#### Acceptance Criteria

1. WHEN the Context Builder estimates session token count exceeds `session_compact_threshold_tokens`, THE Context Builder SHALL trigger a separate pai.chat() call for session compression
2. WHEN session compression is triggered, THE Context Builder SHALL pass recent session history to pai.chat() with a compression prompt
3. WHEN compression completes, THE Context Builder SHALL write the compressed summary to `memory/thread-<slug>.md`
4. WHEN compression completes, THE Context Builder SHALL use the compressed summary in the final LLM context

### Requirement 12: Cross-Session Memory Management

**User Story:** As the memory processor, I want to maintain and update cross-session memory, so that agents retain knowledge across conversations.

#### Acceptance Criteria

1. WHEN the Run-loop completes processing a message, THE Run-loop SHALL emit a `session_turn_completed` event with agent_id, thread_id, peer_id, and new messages
2. WHEN a `session_turn_completed` event is emitted, THE Memory Processor SHALL asynchronously estimate peer memory token count
3. WHEN peer memory token count exceeds `compact_threshold_tokens`, THE Memory Processor SHALL trigger pai.chat() to generate a peer memory summary
4. WHEN peer memory summary completes, THE Memory Processor SHALL write it to `memory/user-<peer_id>.md`
5. WHEN the Memory Processor runs periodic cron tasks, THE Memory Processor SHALL trigger agent-level memory summarization via pai.chat()
6. WHEN agent memory summarization completes, THE Memory Processor SHALL write it to `memory/agent.md`
7. IF Memory Processor encounters errors, THEN THE Memory Processor SHALL log errors to daemon log without affecting run-loop

### Requirement 13: LLM Call Retry and Error Handling

**User Story:** As the run-loop, I want to retry failed LLM calls with exponential backoff, so that transient failures don't cause message loss.

#### Acceptance Criteria

1. WHEN pai.chat() fails with a transient error (network, timeout, rate limit), THE Run-loop SHALL retry up to `retry.max_attempts` times with exponential backoff
2. WHEN pai.chat() fails with a permanent error (authentication, policy violation), THE Run-loop SHALL not retry and shall write an error record to the thread
3. WHEN all retries are exhausted, THE Run-loop SHALL write an error record to the thread and continue to the next message
4. WHEN an error record is written, THE Error Record SHALL include error type, message, and timestamp

### Requirement 14: IPC Protocol and Message Types

**User Story:** As the IPC layer, I want to define and handle all message types between xar and xgw, so that communication is reliable and extensible.

#### Acceptance Criteria

1. THE IPC Protocol SHALL use WebSocket over Unix socket (`~/.theclaw/xar.sock`) as primary transport
2. WHERE Unix socket is unavailable, THE IPC Protocol SHALL fallback to TCP loopback on port specified by `XAR_IPC_PORT` environment variable
3. WHEN xgw sends an inbound message, THE Message Format SHALL include: type, agent_id, message (with source, content, reply_context)
4. WHEN xar sends streaming tokens, THE Message Format SHALL include: type, session_id, token (or delta for thinking)
5. WHEN xar sends management responses, THE Message Format SHALL include: type, data (for success) or message (for error)

### Requirement 15: Daemon Logging

**User Story:** As an operator, I want to monitor daemon operations through logs, so that I can troubleshoot issues.

#### Acceptance Criteria

1. WHEN the Daemon starts or stops, THE Daemon SHALL write startup/shutdown events to `~/.theclaw/logs/xar.log`
2. WHEN the IPC Server starts or stops, THE Daemon SHALL write connection events to the daemon log
3. WHEN a run-loop starts or stops, THE Daemon SHALL write lifecycle events to the daemon log
4. WHEN messages are enqueued or dequeued, THE Daemon SHALL write queue events with agent_id and source to the daemon log
5. WHEN errors occur, THE Daemon SHALL write error details to the daemon log
6. WHEN the daemon log exceeds 10000 lines, THE Daemon SHALL rotate the log file

### Requirement 16: Agent Logging

**User Story:** As an operator, I want to monitor per-agent operations through logs, so that I can debug agent-specific issues.

#### Acceptance Criteria

1. WHEN a run-loop processes a message, THE Run-loop SHALL write message processing start/completion events to `~/.theclaw/agents/<id>/logs/agent.log`
2. WHEN the Run-loop calls the LLM, THE Run-loop SHALL write LLM call status (duration, token usage, retry count) to the agent log
3. WHEN memory updates are triggered, THE Memory Processor SHALL write update events to the agent log
4. WHEN outbound delivery occurs, THE Run-loop SHALL write delivery status to the agent log
5. WHEN the agent log exceeds 10000 lines, THE Run-loop SHALL rotate the log file

### Requirement 17: Configuration Management

**User Story:** As an operator, I want to configure agent behavior through config files, so that I can customize agent parameters.

#### Acceptance Criteria

1. WHEN an agent is initialized, THE System SHALL create `config.json` with default values for provider, model, routing, memory thresholds, and retry settings
2. WHEN the Daemon loads an agent, THE Daemon SHALL read and validate `config.json`
3. WHEN the Daemon loads an agent, THE Daemon SHALL cache the configuration in memory for the lifetime of the run-loop
4. IF `config.json` is invalid or missing required fields, THEN THE Daemon SHALL skip that agent and log an error

### Requirement 18: Environment Variable Configuration

**User Story:** As an operator, I want to configure xar through environment variables, so that I can customize behavior without modifying files.

#### Acceptance Criteria

1. WHERE `THECLAW_HOME` environment variable is set, THE System SHALL use it as the data root directory instead of `~/.theclaw`
2. WHERE `XAR_IPC_PORT` environment variable is set, THE IPC Server SHALL use it as the TCP fallback port instead of default 18792
3. WHERE `XAR_LOG_LEVEL` environment variable is set, THE Daemon SHALL set log level to the specified value (debug, info, warn, error)

### Requirement 19: Exit Codes

**User Story:** As a CLI user, I want clear exit codes to distinguish error types, so that I can write reliable scripts.

#### Acceptance Criteria

1. WHEN a command succeeds, THE System SHALL exit with code 0
2. WHEN a runtime error occurs (daemon not running, agent not found, IPC error), THE System SHALL exit with code 1
3. WHEN a usage error occurs (missing required parameter, invalid parameter value), THE System SHALL exit with code 2

### Requirement 20: System Agents

**User Story:** As the system, I want to initialize system agents with predefined roles, so that core functionality is available.

#### Acceptance Criteria

1. WHEN the system is initialized, THE System SHALL support initialization of four system agents: `admin`, `warden`, `maintainer`, `evolver`
2. WHEN a system agent is initialized, THE System SHALL set kind to `system` in `config.json`
3. WHEN a system agent is initialized, THE System SHALL generate role-appropriate `IDENTITY.md` and `USAGE.md` files
