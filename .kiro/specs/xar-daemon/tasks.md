# Implementation Plan: xar Daemon

## Overview

This implementation plan breaks down the xar daemon into four phases, progressing from foundational infrastructure through core message processing to advanced features. Each phase builds on the previous one, with property-based tests validating correctness properties at each stage.

## Tasks

### Phase 1: IPC Server and Message Queue Infrastructure

- [ ] 1.1 Set up project structure and core types
  - Create `src/types.ts` with IPC message types, InboundMessage, ReplyContext interfaces
  - Create `src/daemon/types.ts` with Daemon-specific types
  - Create `src/agent/types.ts` with Agent-specific types
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

- [ ] 1.2 Implement AsyncQueue message buffer
  - Implement `src/agent/queue.ts` with AsyncQueue<T> class
  - Support push(), close(), and async iteration via Symbol.asyncIterator
  - _Requirements: 5.2, 5.3_

- [ ]* 1.3 Write property test for AsyncQueue FIFO ordering
  - **Property 1: Message Queue FIFO Ordering**
  - **Validates: Requirements 5.2, 5.3**

- [ ] 1.4 Implement IPC Server (WebSocket over Unix socket)
  - Create `src/daemon/server.ts` with IpcServer interface
  - Support Unix socket primary transport and TCP fallback
  - Handle WebSocket connections and message routing
  - _Requirements: 14.1, 14.2_

- [ ] 1.5 Implement IPC message routing by agent_id
  - Route inbound_message to correct agent queue
  - Maintain queue registry per agent
  - _Requirements: 5.1_

- [ ]* 1.6 Write property test for message routing
  - **Property 11: Message Format Validity**
  - **Validates: Requirements 14.3**

- [ ] 1.7 Implement PID file management
  - Create `src/daemon/pid.ts` with writePidFile(), readPidFile(), deletePidFile()
  - Check for existing daemon before starting
  - _Requirements: 1.1, 1.7, 1.8_

- [ ] 1.8 Implement Daemon lifecycle (start/stop/status)
  - Create `src/daemon/index.ts` with DaemonImpl class
  - Implement start() to fork background process and initialize IPC server
  - Implement stop() for graceful shutdown with SIGTERM handling
  - Implement status() to return daemon status
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ]* 1.9 Write property test for graceful shutdown
  - **Property 20: Graceful Shutdown Completion**
  - **Validates: Requirements 1.4**

- [ ] 1.10 Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

### Phase 2: Agent Management and Run-loop Foundation

- [ ] 2.1 Implement Agent initialization (xar init)
  - Create `src/commands/init.ts` command handler
  - Create directory structure at ~/.theclaw/agents/<id>/
  - Generate default IDENTITY.md, USAGE.md, config.json
  - Initialize inbox thread via ThreadLib.init()
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

- [ ]* 2.2 Write property test for agent initialization
  - **Property 18: Directory Structure Completeness**
  - **Validates: Requirements 2.1**

- [ ] 2.3 Implement Agent start/stop commands
  - Create `src/commands/start.ts` to send agent_start via IPC
  - Create `src/commands/stop.ts` to send agent_stop via IPC
  - _Requirements: 3.1, 3.4_

- [ ] 2.4 Implement Agent status and list commands
  - Create `src/commands/status.ts` with --json support
  - Create `src/commands/list.ts` with --json support
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 2.5 Implement Daemon command handlers
  - Create `src/commands/daemon.ts` with start/stop/status subcommands
  - Wire to DaemonImpl
  - _Requirements: 1.1, 1.4, 1.6_

- [ ] 2.6 Implement CLI entry point
  - Create `src/index.ts` with commander setup
  - Register all commands (daemon, init, start, stop, status, list)
  - Implement error handling with exit codes (0, 1, 2)
  - _Requirements: 19.1, 19.2, 19.3_

- [ ] 2.7 Implement Agent configuration loading and validation
  - Create `src/agent/config.ts` with loadAgentConfig(), validateConfig()
  - Cache config in memory during run-loop lifetime
  - _Requirements: 17.1, 17.2, 17.3, 17.4_

- [ ]* 2.8 Write property test for configuration validation
  - **Property 14: Configuration Validation**
  - **Validates: Requirements 17.2, 17.4**

- [ ] 2.9 Implement Run-loop foundation
  - Create `src/agent/run-loop.ts` with RunLoop interface
  - Implement message consumption loop (for await)
  - Implement error handling and logging
  - _Requirements: 5.3, 6.5_

- [ ]* 2.10 Write property test for run-loop error recovery
  - **Property 9: Run-loop Continuation After Error**
  - **Validates: Requirements 13.3**

- [ ] 2.11 Implement environment variable configuration
  - Support THECLAW_HOME, XAR_IPC_PORT, XAR_LOG_LEVEL
  - Apply to all components
  - _Requirements: 18.1, 18.2, 18.3_

- [ ] 2.12 Implement daemon and agent logging
  - Create `src/daemon/logger.ts` with daemon log setup
  - Create `src/agent/logger.ts` with per-agent log setup
  - Implement log rotation at 10000 lines
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 16.1, 16.2, 16.3, 16.4, 16.5_

- [ ]* 2.13 Write property test for log entry presence
  - **Property 13: Log Entry Presence**
  - **Validates: Requirements 15.1, 15.5**

- [ ] 2.14 Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Message Processing and Thread Integration

- [ ] 3.1 Implement Router (thread routing logic)
  - Create `src/agent/router.ts` with Router interface
  - Support per-peer, per-session, per-agent routing modes
  - _Requirements: 6.1_

- [ ]* 3.2 Write property test for router determinism
  - **Property 2: Router Determinism**
  - **Validates: Requirements 6.1**

- [ ] 3.3 Implement ThreadLib integration
  - Create `src/agent/thread-lib.ts` wrapper around thread library
  - Implement open(), init(), exists(), destroy() methods
  - _Requirements: 6.2_

- [ ] 3.4 Implement message persistence to threads
  - Integrate ThreadStore.push() for inbound messages
  - Integrate ThreadStore.pushBatch() for LLM responses
  - _Requirements: 6.3, 6.4, 10.1, 10.2, 10.3_

- [ ]* 3.5 Write property test for message persistence round-trip
  - **Property 4: Message Persistence Round-trip**
  - **Validates: Requirements 6.3, 6.4**

- [ ] 3.6 Implement Context Builder
  - Create `src/agent/context.ts` with ContextBuilder interface
  - Load thread history via ThreadStore.peek()
  - Load memory files (agent, peer, session)
  - Assemble system prompt from IDENTITY.md
  - _Requirements: 7.1, 7.2, 7.3_

- [ ]* 3.7 Write property test for context assembly completeness
  - **Property 5: Context Assembly Completeness**
  - **Validates: Requirements 7.2, 7.3**

- [ ] 3.8 Implement IpcChunkWriter for token streaming
  - Create `src/daemon/ipc-chunk-writer.ts` extending Writable
  - Send stream_token messages for each token
  - _Requirements: 8.1, 8.2_

- [ ]* 3.9 Write property test for token streaming reconstruction
  - **Property 6: Token Streaming Reconstruction**
  - **Validates: Requirements 8.2**

- [ ] 3.10 Implement LLM call integration with pai library
  - Integrate pai.chat() with streaming support
  - Pass IpcChunkWriter for token streaming
  - Pass bash_exec tool via pai.createBashExecTool()
  - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 9.1_

- [ ] 3.11 Implement streaming message delivery
  - Send stream_start before LLM call
  - Send stream_token for each token
  - Send stream_thinking for thinking tokens
  - Send stream_end after completion
  - Send stream_error on failure
  - _Requirements: 8.3, 8.4, 8.5, 8.6_

- [ ]* 3.12 Write property test for streaming message format validity
  - **Property 12: Streaming Message Format Validity**
  - **Validates: Requirements 14.4**

- [ ] 3.13 Implement LLM response persistence
  - Convert pai messages to ThreadEventInput format
  - Set source to 'self' for assistant, 'tool:<name>' for tools
  - Write to thread via ThreadStore.pushBatch()
  - _Requirements: 10.1, 10.2, 10.3_

- [ ]* 3.14 Write property test for batch message atomicity
  - **Property 7: Batch Message Atomicity**
  - **Validates: Requirements 10.3**

- [ ] 3.15 Implement LLM retry logic with exponential backoff
  - Distinguish transient vs permanent errors
  - Retry transient errors up to max_attempts
  - Write error records for permanent errors
  - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [ ]* 3.16 Write property test for retry exponential backoff
  - **Property 10: Retry Exponential Backoff**
  - **Validates: Requirements 13.1**

- [ ] 3.17 Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

### Phase 4: Memory Management and Advanced Features

- [ ] 4.1 Implement session-level memory compression
  - Create `src/agent/memory-compressor.ts`
  - Estimate session token count
  - Trigger pai.chat() for compression when threshold exceeded
  - Write compressed summary to memory/thread-<slug>.md
  - _Requirements: 7.4, 7.5, 11.1, 11.2, 11.3, 11.4_

- [ ]* 4.2 Write property test for memory compression idempotence
  - **Property 8: Memory Compression Idempotence**
  - **Validates: Requirements 11.1, 11.3**

- [ ] 4.3 Implement Memory Processor for cross-session memory
  - Create `src/agent/memory.ts` with MemoryProcessor interface
  - Implement async memory update scheduling
  - Estimate peer memory token count
  - Trigger compression when threshold exceeded
  - Write to memory/user-<peer_id>.md
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.7_

- [ ] 4.4 Implement Cron Scheduler for periodic memory updates
  - Create `src/daemon/scheduler.ts` with CronScheduler
  - Trigger agent-level memory summarization periodically
  - Write to memory/agent.md
  - _Requirements: 12.5, 12.6_

- [ ] 4.5 Implement System Agents initialization
  - Support initialization of admin, warden, maintainer, evolver
  - Generate role-appropriate IDENTITY.md and USAGE.md
  - Set kind to 'system' in config.json
  - _Requirements: 20.1, 20.2, 20.3_

- [ ]* 4.6 Write property test for system agent initialization
  - **Property 17: System Agent Initialization**
  - **Validates: Requirements 20.1, 20.2**

- [ ] 4.7 Implement Agent status consistency tracking
  - Track agent status transitions (stopped ↔ started)
  - Update config.json on status changes
  - _Requirements: 3.2, 3.3, 3.5, 3.6_

- [ ]* 4.8 Write property test for agent status consistency
  - **Property 3: Agent Status Consistency**
  - **Validates: Requirements 3.2, 3.3, 3.5, 3.6**

- [ ] 4.9 Implement Agent status initialization
  - Set status to 'stopped' on init
  - _Requirements: 2.4_

- [ ]* 4.10 Write property test for agent status initialization
  - **Property 19: Agent Status Initialization**
  - **Validates: Requirements 2.4**

- [ ] 4.11 Implement Environment variable override
  - Apply THECLAW_HOME, XAR_IPC_PORT, XAR_LOG_LEVEL throughout
  - _Requirements: 18.1, 18.2, 18.3_

- [ ]* 4.12 Write property test for environment variable override
  - **Property 15: Environment Variable Override**
  - **Validates: Requirements 18.1, 18.2, 18.3**

- [ ] 4.13 Implement Exit code correctness
  - Return 0 for success
  - Return 1 for runtime errors
  - Return 2 for usage errors
  - _Requirements: 19.1, 19.2, 19.3_

- [ ]* 4.14 Write property test for exit code correctness
  - **Property 16: Exit Code Correctness**
  - **Validates: Requirements 19.1, 19.2, 19.3**

- [ ] 4.15 Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4.16 Integration testing
  - Test end-to-end daemon startup with multiple agents
  - Test message flow from IPC through run-loop to thread
  - Test LLM streaming with token delivery
  - Test graceful shutdown with in-flight messages
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 5.1, 6.1, 8.1, 8.2_

- [ ] 4.17 Final checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property-based tests and can be skipped for faster MVP
- Each phase builds on the previous one with incremental validation
- Property tests validate universal correctness properties across generated inputs
- Unit tests validate specific examples and edge cases
- All code follows repo-convention.md standards (TypeScript ESM, bash shell, proper imports with .js extensions)
- IPC implementation uses ws library for WebSocket support
- Thread library integration via npm dependency (thread package)
- pai library integration via npm dependency (pai package)
