# Requirements Document

## Introduction

本功能为 xar daemon 实现 agent-to-agent 内部消息投递机制。

**完整消息流**：
1. Agent A 的 LLM 通过 `bash_exec` 调用 `xar send <target_agent_id> "<message>"` 发出消息
2. `xar send` 从环境变量 `XAR_AGENT_ID`（发送方 ID）和 `XAR_CONV_ID`（当前 conversation ID）读取上下文，构造 `internal:agent:<conv_id>:<sender_id>` source
3. `xar send` 通过 IPC 将 `inbound_message` 投递给 daemon
4. Daemon 找到目标 agent 的 AsyncQueue 并 push 进去（已有逻辑，无需修改）
5. 目标 agent 的 run-loop 消费消息，`parseSource()` 解析 `internal:` 格式，路由到对应 thread，调用 LLM 处理
6. 目标 agent 回复时，从收到消息的 source 中解析出 `conv_id`，用同一 `conv_id` 回复

**Per-turn 环境变量注入**：多 agent 并发时全局 `process.env` 会竞态，因此必须通过 per-turn 方式注入。方案是修改 `createBashExecTool()` 支持接收 `extraEnv` 参数，`processTurn` 接受 `extraEnv` 并传给 `createBashExecTool`，run-loop 在调用 `processTurn` 时传入当前 turn 的 `{ XAR_AGENT_ID: agentId, XAR_CONV_ID: convId }`。每个 bash_exec 子进程通过 `spawn` 的 `env` 选项获得正确的 per-turn 环境变量，完全无竞态。

**conv_id 来源**：run-loop 从当前处理消息的 `source` 字段中解析出 `conv_id`（internal source 的第三段；external source 的 `conversation_id` 字段）。这样 `XAR_CONV_ID` 始终反映当前正在处理的对话上下文。

**已经正确工作的部分**（不需要修改）：
- `parseSource()` 已支持 `internal:` 格式解析
- `determineThreadId()` 已支持 internal source 的 thread 路由
- `handleIpcMessage` 的 `inbound_message` 分支已能 push 到目标 queue

**需要修改/新增的部分**：
- `pai` repo：`createBashExecTool()` 新增 `extraEnv` 参数，`spawn` 时合并到子进程环境变量
- `xar` repo：`processTurn` 新增 `extraEnv` 参数并传给 `createBashExecTool`
- `xar` repo：run-loop 在调用 `processTurn` 时传入 `{ XAR_AGENT_ID, XAR_CONV_ID }`
- `xar` repo：`xar send` 从 `XAR_AGENT_ID` / `XAR_CONV_ID` 读取上下文，构造 internal source
- `xar` repo：run-loop 明确处理 internal source 的 no-xgw 路径，消除不必要的 warning
- 测试：补全 internal source 路径的单元测试和属性测试

## Glossary

- **Daemon**: xar daemon 进程，管理所有 agent 的生命周期和消息路由
- **RunLoop**: 每个 agent 的消息处理循环（`RunLoopImpl`），持续从队列消费消息并调用 LLM
- **InboundMessage**: 投递给 agent 的消息结构，包含 `source` 和 `content` 字段
- **Internal_Source**: `internal:` 前缀的 source 地址，格式为 `internal:<conv_type>:<conv_id>:<sender_agent_id>`
- **External_Source**: `external:` 前缀的 source 地址，来自 xgw 转发的外部渠道消息
- **AsyncQueue**: 每个 agent 的内存消息队列（`AsyncQueueImpl`），run-loop 从中消费消息
- **Thread**: agent 的持久化消息存储单元，由 thread lib 管理
- **Agent_Registry**: Daemon 内部维护的 `agents` Map，存储所有运行中 agent 的运行时状态
- **conv_type**: conversation 类型标识，agent-to-agent 场景固定使用 `agent`
- **conv_id**: conversation ID，标识一次 agent 间对话的上下文；从当前处理消息的 source 字段中解析得到
- **XAR_AGENT_ID**: per-turn 注入到 bash_exec 子进程的环境变量，值为当前处理消息的 agent ID
- **XAR_CONV_ID**: per-turn 注入到 bash_exec 子进程的环境变量，值为当前处理消息的 conversation ID

## Requirements

### Requirement 1: Internal Source 解析正确性

**User Story:** As a developer, I want internal source addresses to be correctly parsed, so that agent-to-agent messages carry the right metadata for thread routing and reply addressing.

#### Acceptance Criteria

1. WHEN `parseSource()` receives a string matching `internal:<conv_type>:<conv_id>:<sender_agent_id>`, THE Parser SHALL return a `ParsedSource` with `kind: 'internal'`, `conversation_type`, `conversation_id`, and `sender_agent_id` fields all populated
2. WHEN `parseSource()` receives a string starting with `internal:` but with fewer than 4 colon-separated segments, THE Parser SHALL throw an error with a descriptive message containing the invalid source string
3. FOR ALL valid internal source strings, THE Parser SHALL produce a `ParsedSource` where `kind` is `'internal'` and all three structured fields (`conversation_type`, `conversation_id`, `sender_agent_id`) are non-empty strings

### Requirement 2: Internal Source 的 Thread 路由

**User Story:** As a developer, I want internal messages to be routed to the correct thread based on the agent's routing config, so that agent-to-agent conversations are stored in a predictable location.

#### Acceptance Criteria

1. WHEN `determineThreadId()` is called with routing mode `per-peer` and an internal source, THE Router SHALL use `sender_agent_id` as the peer identifier, producing thread ID `peers/<sender_agent_id>`
2. WHEN `determineThreadId()` is called with routing mode `per-conversation` and an internal source, THE Router SHALL use `conversation_id` as the conversation identifier, producing thread ID `conversations/<conversation_id>`
3. WHEN `determineThreadId()` is called with routing mode `per-agent` and any source (internal or external), THE Router SHALL produce thread ID `main`
4. FOR ALL valid internal source strings and routing modes, THE Router SHALL produce the same thread ID when called multiple times with the same inputs (determinism)

### Requirement 3: RunLoop 对 Internal 消息的明确处理

**User Story:** As a developer, I want the run-loop to explicitly handle internal source messages without spurious warnings, so that the code path is clear and logs are not polluted.

#### Acceptance Criteria

1. WHEN `buildTarget()` receives an internal source, THE RunLoop SHALL return `null` (no outbound xgw target is needed for agent-to-agent messages)
2. WHEN processing a message with an internal source, THE RunLoop SHALL write the LLM response to the thread as normal records
3. WHEN processing a message with an internal source, THE RunLoop SHALL NOT send `stream_start`, `stream_end`, or `stream_token` events to xgw
4. WHEN processing a message with an internal source and no IPC connection is available, THE RunLoop SHALL NOT log a "no connection available" warning (absence of xgw connection is expected for internal messages)
5. WHEN processing a message with an internal source, THE RunLoop SHALL generate a stream_id using the format `internal:<agent_id>:<seq>` for internal logging purposes

### Requirement 4: Per-turn 环境变量注入到 bash_exec

**User Story:** As a developer, I want each bash_exec invocation to receive the current agent ID and conversation ID as environment variables, so that xar send can construct the correct internal source without race conditions.

#### Acceptance Criteria

1. THE `createBashExecTool()` function in pai SHALL accept an optional `extraEnv` parameter of type `Record<string, string>`, and merge it into the spawned subprocess environment
2. THE `processTurn()` function in xar SHALL accept an optional `extraEnv` parameter and pass it to `createBashExecTool()`
3. WHEN the RunLoop calls `processTurn()` for any message, THE RunLoop SHALL pass `{ XAR_AGENT_ID: agentId, XAR_CONV_ID: convId }` as `extraEnv`, where `convId` is extracted from the message's source field
4. FOR ALL concurrent agent turns, each bash_exec subprocess SHALL receive the `XAR_AGENT_ID` and `XAR_CONV_ID` values corresponding to its own turn (no cross-turn contamination)
5. WHEN `convId` cannot be extracted from the source (e.g. source is `self`), THE RunLoop SHALL use an empty string for `XAR_CONV_ID`

### Requirement 5: xar send 支持 Internal Source 自动构造

**User Story:** As an agent (LLM), I want to send messages to other agents with a simple CLI call, so that I don't need to manually construct the internal source address.

#### Acceptance Criteria

1. WHEN `xar send <target_id> <message>` is invoked and both `XAR_AGENT_ID` and `XAR_CONV_ID` environment variables are set, THE CLI SHALL construct the source as `internal:agent:<XAR_CONV_ID>:<XAR_AGENT_ID>` and deliver the message via IPC `inbound_message`
2. WHEN `--source` is explicitly provided, THE CLI SHALL use it as-is (existing behavior preserved for testing/debugging), ignoring `XAR_AGENT_ID` and `XAR_CONV_ID`
3. WHEN neither `XAR_AGENT_ID` / `XAR_CONV_ID` are set nor `--source` is provided, THE CLI SHALL exit with code 2 and print a descriptive error to stderr
4. WHEN the target agent is not running, THE CLI SHALL receive an error response from the daemon and exit with code 1
5. WHEN the daemon is not running, THE CLI SHALL exit with code 1 and print a descriptive error to stderr

### Requirement 6: 错误隔离

**User Story:** As a developer, I want internal message processing errors to be isolated, so that a failed agent-to-agent message does not crash the receiving agent's run-loop.

#### Acceptance Criteria

1. WHEN processing an internal message fails at the LLM call stage, THE RunLoop SHALL write an error record to the thread and continue processing subsequent messages
2. WHEN the target agent specified in a `xar send` call is not running, THE Daemon SHALL return an error IPC response and log the drop event with `target_agent_id` and `source`
3. WHEN an internal message is pushed to a closed queue (agent stopped between lookup and push), THE Daemon SHALL log a warning and not propagate the error to the sender
