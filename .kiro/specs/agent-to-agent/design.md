# Design Document: Agent-to-Agent Internal Communication

## Overview

本设计实现 xar daemon 内的 agent-to-agent 消息投递机制。Agent（LLM）通过 `bash_exec` 调用 `xar send` 发出消息，`xar send` 从 per-turn 注入的环境变量中读取发送方上下文，构造 `internal:` source 地址，通过 IPC 投递给 daemon，daemon 将消息 push 到目标 agent 的 AsyncQueue。整个路径不经过 xgw。

涉及两个 repo 的修改：
- **pai repo**：`createBashExecTool()` 新增 `extraEnv` 参数
- **xar repo**：`processTurn`、`run-loop`、`xar send` 的修改，以及新增测试

## Architecture

```
Agent A (LLM turn)
  │
  ├─ bash_exec: xar send admin "msg"
  │     env: XAR_AGENT_ID=evolver, XAR_CONV_ID=conv-abc
  │
  └─► xar send (CLI process)
        │  reads XAR_AGENT_ID, XAR_CONV_ID from env
        │  constructs source: internal:agent:conv-abc:evolver
        │
        └─► IPC: inbound_message { agent_id: "admin", message: { source, content } }
              │
              └─► Daemon.handleIpcMessage
                    │  agents.get("admin").queue.push(message)
                    │
                    └─► Agent B (admin) RunLoop
                          │  parseSource("internal:agent:conv-abc:evolver")
                          │  determineThreadId → "peers/evolver"
                          │  processTurn(extraEnv: { XAR_AGENT_ID: "admin", XAR_CONV_ID: "conv-abc" })
                          │
                          └─► LLM processes message, writes to thread
                                (no stream_start/stream_end sent to xgw)
```

## Components and Interfaces

### 1. pai: `createBashExecTool(extraEnv?)`

**文件**：`pai/src/tools/bash-exec.ts`

新增可选参数 `extraEnv?: Record<string, string>`，在 `spawn` 时合并到子进程环境变量：

```typescript
export function createBashExecTool(extraEnv?: Record<string, string>): Tool {
  const shell = detectShell()
  return {
    // ...
    handler: async (args: BashExecArgs, sessionSignal?: AbortSignal) => {
      const proc = spawn(shell, ['-c', args.command], {
        cwd: args.cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,  // undefined = inherit
        detached: !IS_WIN32,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      // ... rest unchanged
    }
  }
}
```

`env: undefined` 时 Node.js 默认继承 `process.env`，保持向后兼容。

### 2. xar: `processTurn` 新增 `extraEnv`

**文件**：`xar/src/agent/turn.ts`

```typescript
export interface TurnParams {
  // ... existing fields ...
  /** Per-turn environment variables injected into bash_exec subprocesses */
  extraEnv?: Record<string, string> | undefined
}

export async function processTurn(params: TurnParams): Promise<TurnResult> {
  const { extraEnv } = params
  const tools: Tool[] = [createBashExecTool(extraEnv), ...(extraTools ?? [])]
  // ... rest unchanged
}
```

### 3. xar: `extractConvId(source)` 工具函数

**文件**：`xar/src/agent/router.ts`（新增导出函数）

从 source 字段提取 `conv_id`，供 run-loop 构造 `extraEnv`：

```typescript
/**
 * Extract conversation ID from a source address.
 * - internal: returns conversation_id (3rd segment)
 * - external: returns conversation_id field
 * - self / unknown: returns empty string
 */
export function extractConvId(source: string): string {
  try {
    const parsed = parseSource(source)
    return parsed.conversation_id ?? ''
  } catch {
    return ''
  }
}
```

### 4. xar: RunLoop 传入 `extraEnv`

**文件**：`xar/src/agent/run-loop.ts`

在 `processMessage` 中，调用 `processTurn` 前构造 `extraEnv`：

```typescript
private async processMessage(msg: InboundMessage): Promise<void> {
  const convId = extractConvId(msg.source)
  const extraEnv: Record<string, string> = {
    XAR_AGENT_ID: this.agentId,
    XAR_CONV_ID: convId,
  }

  // ... existing setup ...

  const result = await processTurn({
    // ... existing params ...
    extraEnv,
  })
}
```

**Internal source 的 no-xgw 路径**：当 `target === null`（internal source），不创建 `deliver` 对象，不发送 stream 事件，不记录 "no connection" warning：

```typescript
// 现有代码（需修改）
if (!conn) {
  this.logger.warn(`No IPC connection available...`)  // ← 对 internal 消息不应 warn
}

// 修改后
const isInternal = parseSource(msg.source).kind === 'internal'
if (!conn && !isInternal) {
  this.logger.warn(`No IPC connection available for streaming...`)
}
```

stream_id 对 internal 消息使用 `internal:<agentId>:<seq>` 格式（已有实现，确认正确）。

### 5. xar: `xar send` 支持 Internal Source 自动构造

**文件**：`xar/src/commands/send.ts`

优先级：`--source` 显式参数 > 环境变量自动构造 > 报错退出

```typescript
// 构造 internal source 的逻辑
function buildInternalSource(opts: { source?: string }): string {
  if (opts.source) return opts.source  // explicit --source wins

  const agentId = process.env['XAR_AGENT_ID']
  const convId = process.env['XAR_CONV_ID']

  if (!agentId || !convId) {
    throw new CliError(
      'Cannot construct internal source: XAR_AGENT_ID and XAR_CONV_ID must be set, or use --source explicitly',
      2,
    )
  }

  return `internal:agent:${convId}:${agentId}`
}
```

`xar send` 的 `--source` 默认值从 `'external:cli:default:dm:cli:cli'` 改为 `undefined`（不再有默认值），由 `buildInternalSource` 决定最终 source。

## Data Models

### ParsedSource（已有，无需修改）

```typescript
interface ParsedSource {
  kind: 'external' | 'internal' | 'self'
  channel_id?: string
  conversation_type?: string
  conversation_id?: string
  peer_id?: string
  sender_agent_id?: string
}
```

internal source 解析结果：
- `kind`: `'internal'`
- `conversation_type`: source 第二段（如 `'agent'`）
- `conversation_id`: source 第三段（如 `'conv-abc-123'`）
- `sender_agent_id`: source 第四段（如 `'evolver'`）

### InboundMessage（已有，无需修改）

```typescript
interface InboundMessage {
  source: string   // e.g. "internal:agent:conv-abc:evolver"
  content: string
}
```

### TurnParams（新增 `extraEnv` 字段）

```typescript
interface TurnParams {
  // ... existing ...
  extraEnv?: Record<string, string> | undefined
}
```

## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

**Property 1: Internal source round-trip parsing**

*For any* valid triple `(conv_type, conv_id, sender_agent_id)` of non-empty strings containing no colons, constructing `internal:<conv_type>:<conv_id>:<sender_agent_id>` and parsing it with `parseSource()` should return a `ParsedSource` with `kind: 'internal'` and all three fields matching the original values.

**Validates: Requirements 1.1, 1.3**

**Property 2: Invalid internal source always throws**

*For any* string starting with `internal:` that has fewer than 4 colon-separated segments, `parseSource()` should throw an error.

**Validates: Requirements 1.2**

**Property 3: Internal source thread routing is correct and deterministic**

*For any* valid internal source string and any routing mode (`per-peer`, `per-conversation`, `per-agent`), `determineThreadId()` should:
- `per-peer`: return `peers/<sender_agent_id>`
- `per-conversation`: return `conversations/<conversation_id>`
- `per-agent`: return `main`
- Called twice with the same inputs: return the same result

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

**Property 4: extraEnv values flow correctly to each turn**

*For any* agent ID and source string, the `extraEnv` passed to `processTurn` should contain `XAR_AGENT_ID` equal to the agent's ID and `XAR_CONV_ID` equal to the `conv_id` extracted from the source (or empty string if not extractable).

**Validates: Requirements 4.3, 4.5**

**Property 5: xar send internal source construction**

*For any* valid `XAR_AGENT_ID` and `XAR_CONV_ID` values (non-empty strings), `buildInternalSource()` should return a string matching `internal:agent:<XAR_CONV_ID>:<XAR_AGENT_ID>`, which is parseable by `parseSource()` with the correct fields.

**Validates: Requirements 5.1**

## Error Handling

| 場景 | 処理方式 |
|------|---------|
| `parseSource()` 收到格式错误的 internal source | 抛出 `Error`，包含原始 source 字符串 |
| `xar send` 未设置 `XAR_AGENT_ID`/`XAR_CONV_ID` 且无 `--source` | exit 2，stderr 输出描述性错误 |
| `xar send` 目标 agent 不在运行 | daemon 返回 error IPC 响应，CLI exit 1 |
| `xar send` daemon 未运行 | CLI exit 1，stderr 提示先运行 `xar daemon start` |
| run-loop 处理 internal 消息时 LLM 调用失败 | 写 error record 到 thread，继续处理下一条消息 |
| internal 消息 push 到已关闭的 queue | daemon 记录 warn 日志，不向 sender 传播错误 |
| `extractConvId()` 解析失败（如 source 为 `self`） | 返回空字符串，`XAR_CONV_ID` 设为 `''` |

## Testing Strategy

### Unit Tests（`vitest/unit/`）

**`router.test.ts`**（已有，新增 internal source 测试用例）：
- `parseSource()` 对 internal source 的正确解析
- `parseSource()` 对格式错误 internal source 的错误抛出
- `determineThreadId()` 对 internal source 在各路由模式下的结果
- `extractConvId()` 对各种 source 格式的提取结果

**`run-loop.test.ts`**（已有，新增 internal source 行为测试）：
- `buildTarget()` 对 internal source 返回 `null`
- 处理 internal source 消息时不记录 "no connection" warning
- stream_id 格式为 `internal:<agentId>:<seq>`

**`send.test.ts`**（新增）：
- `buildInternalSource()` 在 env 变量设置时的正确构造
- `buildInternalSource()` 在 `--source` 显式提供时的直通行为
- `buildInternalSource()` 在 env 变量缺失时的 exit 2

### Property-Based Tests（`vitest/pbt/`）

使用 `fast-check`，每个属性测试最少运行 100 次。

**`agent-to-agent.pbt.test.ts`**（新增）：

- **Property 1**: Internal source round-trip parsing
  - 生成器：`fc.tuple(fc.stringMatching(/^[a-z0-9-]+$/), fc.stringMatching(/^[a-z0-9-]+$/), fc.stringMatching(/^[a-z0-9-]+$/))`
  - 验证：构造 → 解析 → 字段匹配
  - Tag: `Feature: agent-to-agent, Property 1: internal source round-trip parsing`

- **Property 2**: Invalid internal source always throws
  - 生成器：生成 1-3 段的 `internal:` 前缀字符串
  - 验证：`parseSource()` 抛出错误
  - Tag: `Feature: agent-to-agent, Property 2: invalid internal source always throws`

- **Property 3**: Internal source thread routing correctness and determinism
  - 生成器：随机 internal source + 随机路由模式
  - 验证：thread ID 格式正确，两次调用结果相同
  - Tag: `Feature: agent-to-agent, Property 3: internal source thread routing`

- **Property 4**: extraEnv values flow correctly
  - 生成器：随机 agentId + 随机 source（internal/external/self）
  - 验证：`XAR_AGENT_ID` 等于 agentId，`XAR_CONV_ID` 等于 `extractConvId(source)`
  - Tag: `Feature: agent-to-agent, Property 4: extraEnv values flow correctly`

- **Property 5**: xar send internal source construction
  - 生成器：随机 agentId + convId（非空，无冒号）
  - 验证：构造结果可被 `parseSource()` 解析，字段匹配
  - Tag: `Feature: agent-to-agent, Property 5: xar send internal source construction`

### 测试策略说明

- 单元测试覆盖具体示例、边界条件和错误路径
- 属性测试覆盖通用正确性（随机输入，100+ 次迭代）
- 两者互补：单元测试捕获具体 bug，属性测试验证通用正确性
- 不需要 integration test（daemon 的 `inbound_message` 路径已有现有测试覆盖）
