# xar - Agent Runtime Daemon

xar 是 TheClaw 架构的核心 runtime daemon，负责 agent 生命周期管理、消息调度、LLM 调用和出站投递。

模块类型：**CLI/Daemon**（见 [CLI-LIB-Module-Spec.md](../TheClaw/CLI-LIB-Module-Spec.md)）

架构文档：[ARCH.md](../TheClaw/ARCH.md)

---

## 设计原则

1. **xar 是纯 CLI/Daemon 模块**：没有 lib 入口，不被其他模块 import。外部通过 IPC 和 CLI 与它交互。
2. **依赖 lib，不内嵌逻辑**：thread 和 pai 作为 npm dependencies import，不复制代码。
3. **Agent 即目录**：每个 agent 的全部数据存放在 `~/.theclaw/agents/<id>/`，文件系统是 ground truth。
4. **并发粒度为 thread**：不同 agent 并发，同一 agent 的不同 thread 并发，同一 thread 内串行（通过 per-thread promise chain 保证）。
5. **Streaming 优先**：LLM token 通过 IPC 实时 push 到 xgw，没有批处理边界。

---

## 目录结构

```
xar/
├── src/
│   ├── index.ts                  # CLI 入口（commander，命令名 xar）
│   ├── config.ts                 # 环境变量与路径配置
│   ├── logging.ts                # Daemon/agent 日志工具
│   ├── types.ts                  # 共享类型定义（IpcMessage、InboundMessage 等）
│   ├── commands/                 # CLI 子命令（薄包装，通过 IPC 与 daemon 通信）
│   │   ├── daemon.ts             # xar daemon start/stop/status
│   │   ├── init.ts               # xar init <id>
│   │   ├── start.ts              # xar start <id>
│   │   ├── stop.ts               # xar stop <id>
│   │   ├── status.ts             # xar status [<id>]
│   │   └── list.ts               # xar list
│   ├── daemon/
│   │   ├── index.ts              # Daemon 主入口（生命周期、agent 管理、IPC 消息处理）
│   │   ├── ipc-chunk-writer.ts   # Writable 实现，将 LLM token 写入 IPC stream
│   │   └── pid.ts                # PID 文件管理
│   ├── agent/
│   │   ├── config.ts             # Agent 配置加载与校验
│   │   ├── context.ts            # LLM context 构建（system prompt 组装）
│   │   ├── deliver.ts            # 出站投递（通过 IPC → xgw）
│   │   ├── memory.ts             # Session compact（对齐 agent repo compactor 逻辑）
│   │   ├── queue.ts              # AsyncQueue<Message>（per-agent 内存消息队列）
│   │   ├── router.ts             # 入站消息 → 目标 thread 分配
│   │   ├── run-loop.ts           # 消息处理循环（per-agent async，持续运行）
│   │   ├── session.ts            # Session JSONL 读写、token 估算、compact state
│   │   ├── thread-lib.ts         # thread lib 封装（open/init/exists）
│   │   └── types.ts              # Agent 相关类型定义
│   ├── ipc/
│   │   ├── types.ts              # IPC Server/Connection 接口
│   │   ├── server.ts             # createIpcServer()（WebSocket over Unix socket + TCP fallback）
│   │   └── client.ts             # IpcClient（CLI 命令用）
│   └── repo-utils/               # 跨 repo 共通工具（从 pai 同步）
├── vitest/
│   ├── unit/
│   └── pbt/
├── package.json
├── tsconfig.json
├── tsup.config.ts                # 单 entry: src/index.ts，带 shebang
├── vitest.config.ts
├── SPEC.md                       ← This document
└── USAGE.md
```

---

## 数据目录结构

```
~/.theclaw/
├── xar.sock                      # Unix socket（IPC Server 监听地址）
├── xar.pid                       # PID 文件
├── started-agents.json           # 运行时注册表（daemon 重启时自动恢复的 agent 列表）
├── logs/
│   └── xar.log                   # Daemon 运行日志
└── agents/
    └── <agent_id>/
        ├── IDENTITY.md           # Agent system prompt（角色、能力、行为准则）
        ├── USAGE.md              # 对外使用说明（给人类和其他 agent）
        ├── config.json           # Agent 配置（见 Agent 配置格式）
        ├── sessions/             # pai chat session 文件（JSONL，per-thread）
        │   ├── <thread_id>.jsonl
        │   └── compact-state-<thread_id>.json  # compact 进度状态
        ├── memory/               # Memory 文件（Markdown）
        │   ├── agent.md          # 跨所有 peer/thread 的记忆
        │   ├── user-<peer_id>.md # per-peer 跨 thread 的记忆
        │   └── thread-<thread_id>.md  # per-thread 压缩摘要
        ├── threads/              # Agent 私有 thread 目录
        │   ├── peers/            # per-peer threads（routing=per-peer 时）
        │   ├── conversations/    # per-conversation threads（routing=per-conversation 时）
        │   └── main/             # per-agent 单一 thread（routing=per-agent 时）
        ├── workdir/              # 临时工作区
        └── logs/
            └── agent.log
```

---

## Agent 配置格式

`~/.theclaw/agents/<id>/config.json`（静态配置，不含运行时状态）：

```json
{
  "agent_id": "admin",
  "kind": "system",
  "pai": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "routing": {
    "default": "per-peer"
  },
  "memory": {
    "compact_threshold_tokens": 8000,
    "session_compact_threshold_tokens": 4000
  },
  "retry": {
    "max_attempts": 3
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_id` | string | Agent 唯一标识，与目录名一致 |
| `kind` | `"system"` \| `"user"` | Agent 类型 |
| `pai.provider` | string | pai provider 名称 |
| `pai.model` | string | 使用的模型 |
| `routing.default` | `"per-peer"` \| `"per-conversation"` \| `"per-agent"` | 消息路由模式 |
| `memory.compact_threshold_tokens` | number | 触发跨 session memory 压缩的 token 阈值 |
| `memory.session_compact_threshold_tokens` | number | 触发 session 内压缩的 token 阈值 |
| `retry.max_attempts` | number | LLM 调用失败最大重试次数 |

**注意**：`config.json` 不含 `status` 字段。Agent 运行状态（started/stopped）是纯运行时概念，由 daemon 内存维护，并持久化到 `~/.theclaw/started-agents.json`（daemon 重启时用于恢复）。

---

## CLI 命令

### Daemon 管理

```
xar daemon start              # 启动 xar daemon（后台，fork 子进程）
xar daemon stop               # 停止 xar daemon（发送 SIGTERM）
xar daemon status             # 查看 daemon 运行状态（PID、uptime、已注册 agent 数）
```

**`xar daemon start` 行为**：
1. 检查 PID 文件，若 daemon 已运行则报错退出（退出码 1）。
2. 通过 `spawn('xar', ['__daemon'], { detached: true })` fork 子进程，父进程退出。
3. 子进程写入 PID 文件（`~/.theclaw/xar.pid`）。
4. 子进程启动 IPC Server（`~/.theclaw/xar.sock`）。
5. 子进程读取 `~/.theclaw/started-agents.json`，为其中每个 agent 启动 run-loop。

**`xar daemon stop` 行为**：
1. 读取 PID 文件，发送 SIGTERM。
2. Daemon 收到 SIGTERM 后优雅关闭：停止接受新消息，等待所有 run-loop 完成当前消息处理，关闭 IPC Server，删除 PID 文件和 socket 文件。
3. 超时（默认 30s）后强制 SIGKILL。

### Agent 管理

```
xar init <id> [--kind system|user]   # 初始化 agent
xar start <id>                       # 启动 agent（注册到 daemon）
xar stop <id>                        # 停止 agent（从 daemon 注销）
xar status [<id>]                    # 查看 agent 状态（支持 --json）
xar list                             # 列出所有 agent（支持 --json）
```

**`xar init <id>` 行为**：
1. 创建 `~/.theclaw/agents/<id>/` 目录结构（含 `threads/peers/`、`threads/conversations/`、`threads/main/`）。
2. 生成默认 `IDENTITY.md`、`USAGE.md`、`config.json`。
3. 若 agent 已存在，报错退出（退出码 1）。

**`xar start <id>` 行为**：
1. 若 daemon 未运行，报错退出（退出码 1，提示先运行 `xar daemon start`）。
2. 通过 IPC 发送 `agent_start` 消息给 daemon。
3. Daemon 为该 agent 启动 run-loop（若尚未运行），并将其写入 `started-agents.json`。

**`xar stop <id>` 行为**：
1. 通过 IPC 发送 `agent_stop` 消息给 daemon。
2. Daemon 停止向该 agent 的队列投递新消息，等待当前消息处理完成后停止 run-loop，并从 `started-agents.json` 移除。

**`xar status [<id>]`**：
- 无 `<id>`：通过 `daemon_status` IPC 获取运行中 agent 列表，与磁盘 agent 目录合并输出。
- 有 `<id>`：通过 `agent_status` IPC 获取运行时状态（running、queueDepth、processingCount、lastActivityAt）。
- `--json`：输出 JSON。

**`xar list`**：列出所有已初始化的 agent（从 `~/.theclaw/agents/` 目录扫描）。`--json` 输出 JSON。

---

## IPC 协议

### 连接方式

- 默认：Unix socket（`~/.theclaw/xar.sock`）
- Fallback：TCP loopback（`127.0.0.1:18792`，通过环境变量 `XAR_IPC_PORT` 配置）
- 协议：WebSocket（`ws` 库）

两种底层对上层完全透明，封装在 `ipc/server.ts` 和 `ipc/client.ts` 中。

### 消息类型

所有消息均为 JSON，通过 WebSocket `send` / `message` 事件传递。

**入站（xgw → xar）**：

```typescript
// xgw 收到外部消息，转发给 xar
{ type: 'inbound_message', agent_id: string, message: InboundMessage }

interface InboundMessage {
  source: string          // 结构化来源地址（见 thread SPEC 4.3）
  content: string         // 消息内容
}
```

**出站 streaming（xar → xgw）**：

```typescript
// stream_start 携带 OutboundTarget（唯一携带 target 的事件）
{ type: 'stream_start',    target: OutboundTarget, stream_id: string }
// 后续事件通过 stream_id 关联
{ type: 'stream_token',    stream_id: string, token: string }
{ type: 'stream_thinking', stream_id: string, delta: string }
{ type: 'stream_tool_call',    stream_id: string, tool_call: unknown }
{ type: 'stream_tool_result',  stream_id: string, tool_result: unknown }
{ type: 'stream_ctx_usage',    stream_id: string, ctx_usage: CtxUsage }
{ type: 'stream_compact_start', stream_id: string, compact_start: CompactStartInfo }
{ type: 'stream_compact_end',   stream_id: string, compact_end: CompactEndInfo }
{ type: 'stream_end',      stream_id: string }
{ type: 'stream_error',    stream_id: string, error: string }

interface OutboundTarget {
  channel_id: string      // 格式: <channel_type>:<instance>，如 "telegram:main"
  peer_id: string
  conversation_id: string
}
```

> `stream_id` 由 xar 生成，格式为 `<channel_id>:<conversation_id>:<seq>`，seq 为 per-agent 单调递增计数器。

**管理操作（CLI → xar）**：

```typescript
{ type: 'agent_start',  agent_id: string }
{ type: 'agent_stop',   agent_id: string }
{ type: 'agent_status', agent_id: string }
{ type: 'daemon_status' }
```

**管理响应（xar → CLI）**：

```typescript
{ type: 'ok',    data?: unknown }
{ type: 'error', message: string }
```

---

## 核心运行机制

### 1. 消息队列模型

每个 agent 拥有独立的内存消息队列（`AsyncQueue<InboundMessage>`）用于接收 IPC 入站消息。run-loop 从队列消费消息后，立即进行 Thread 分配并持久化到目标 thread。并发粒度为 thread：同一 thread 内的消息通过 per-thread promise chain 串行处理，不同 thread 间并发。

```
IPC server
  → 按 agent_id 分发到 per-agent 队列
  → run-loop 消费 → Thread 分配 → 写入目标 thread
  → per-thread promise chain 保证同一 thread 串行
  → 不同 thread 并发处理
```

`AsyncQueue` 实现：基于 `Promise` 链的异步队列，`push()` 写入，`[Symbol.asyncIterator]` 消费，`close()` 终止迭代。

### 2. Run-loop 生命周期

run-loop 随 daemon 启动后**持续运行**，空队列时 await 等待新消息，不退出。

```typescript
// run-loop 伪代码
async function runLoop(agentId: string, queue: AsyncQueue<InboundMessage>) {
  for await (const msg of queue) {
    try {
      await processMessage(agentId, msg)
    } catch (err) {
      // 记录错误，继续处理下一条消息
      await writeErrorRecord(agentId, msg, err)
    }
  }
}

async function processMessage(agentId: string, msg: InboundMessage) {
  const config = await loadAgentConfig(agentId)
  const threadId = determineThreadId(config, msg.source)
  const threadStore = await openOrCreateThread(agentId, threadId)

  await threadStore.push({
    source: msg.source,
    type: 'message',
    content: msg.content,
  })

  const target = buildOutboundTarget(msg.source)  // 从 source 解析出 channel_id, peer_id, conversation_id
  const streamId = nextStreamId(target)            // <channel_id>:<conversation_id>:<seq>
  const ctx = await buildContext(agentId, config, threadStore, msg, threadId)
  const chunkWriter = new IpcChunkWriter(conn, streamId)
  const deliver = new Deliver(conn, target)

  await deliver.streamStart(streamId)

  for await (const event of pai.chat(ctx.input, ctx.config, chunkWriter, tools, signal)) {
    if (event.type === 'thinking_delta') {
      // thinking 内容桥接到 xgw（xgw 可选择展示或忽略）
      await deliver.streamThinking(streamId, event.delta)
    }
    if (event.type === 'chat_end') {
      // pai Message[] → ThreadEventInput[]（回复写入 thread）
      await threadStore.pushBatch(event.newMessages.map(m => ({
        source: m.role === 'assistant' ? 'self' : `tool:${m.name ?? ''}`,
        type: 'record' as const,
        subtype: m.role === 'tool' ? 'toolcall' : undefined,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })))
      await memory.scheduleUpdate(agentId, threadStore, event)  // 异步触发 memory 更新
    }
  }
  await deliver.streamEnd(streamId)
}
```

### 3. Tool call 执行

tool call（`bash_exec`）由 **pai lib 内部处理**，xar 不拦截。xar 在调用 `pai.chat()` 时传入 `createBashExecTool()`，具体执行逻辑保持在 pai 内部。

### 4. Memory 管理（Session Compact）

每次 LLM 调用**前**，`run-loop.ts` 调用 `compactSession()`（`agent/memory.ts`）：

1. 估算当前 session 文件的 token 数。
2. 若超过 `CONTEXT_USAGE_THRESHOLD`（80%）或距上次 compact 超过 `COMPACT_INTERVAL_TURNS`（10 轮），触发压缩。
3. 将旧对话分为 `toSummarize`（较早部分）和 `recentRaw`（最近 4096 token）。
4. 调用 `pai.chat()` 对 `toSummarize` 生成摘要（支持增量合并已有摘要）。
5. 重写 session 文件：`[system messages] + [summary message] + [recentRaw]`。
6. 将摘要写入 `memory/thread-<threadId>.md`。

compact 失败不影响主流程（non-fatal，记录 warn 日志）。

此逻辑对齐 `agent` repo 的 `runner/compactor.ts`，使用相同的 token 估算和分割算法。

### 5. 出站投递

xar 通过 IPC 直接 push streaming token 给 xgw，不经过 `xgw send` CLI：

```
run-loop → IpcChunkWriter.write(token) → IPC stream_token(stream_id, token) → xgw → channel → peer
```

`IpcChunkWriter` 构造时接收 `stream_id`，`write()` 方法将 token 封装为 `stream_token` IPC 消息发送。

---

## thread lib 接口需求

xar 需要 thread 提供以下 lib 接口（驱动 thread SPECv2 的 lib 层设计）：

### ThreadStore（per-thread 操作对象）

```typescript
interface ThreadStore {
  // 写入事件
  push(event: ThreadEventInput): Promise<ThreadEvent>
  pushBatch(events: ThreadEventInput[]): Promise<ThreadEvent[]>

  // 读取事件（不消费，对应 thread peek）
  peek(opts: PeekOptions): Promise<ThreadEvent[]>

  // 初始化（对应 thread init）
  // 由 ThreadLib.open() 在目录不存在时自动调用
}

interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}

interface PeekOptions {
  lastEventId: number   // 返回 id > lastEventId 的事件，0 表示从头
  limit?: number        // 默认 100
  filter?: string       // SQL WHERE 子句片段（同 thread CLI --filter）
}
```

### ThreadLib（工厂/管理接口）

```typescript
interface ThreadLib {
  // 打开（或初始化）一个 thread，返回 ThreadStore
  // 目录不存在时自动初始化（等价于 thread init）
  open(threadPath: string): Promise<ThreadStore>

  // 显式初始化新 thread，已存在则 throw
  // xar init 时用此接口，语义上要求"必须是新建"
  init(threadPath: string): Promise<ThreadStore>

  // 检查 thread 是否已初始化
  exists(threadPath: string): Promise<boolean>

  // 删除 thread 目录及全部数据（不可逆）
  // xar 删除 agent 时用此接口清理 inbox 和所有私有 thread
  destroy(threadPath: string): Promise<void>
}
```

**说明**：
- xar 不需要 thread 的 subscribe/dispatch/pop 机制（那是 v1 notifier 驱动模型的产物）。
- xar 只需要 `push`/`peek`（读写事件）、`open`（按需打开/创建 thread）、`init`（强制新建）、`destroy`（清理）。
- 消费进度（consumer_progress）由 xar 自己在内存中维护（run-loop 持续运行，不需要持久化消费进度）。

---

## pai lib 接口需求

xar 使用 pai lib 的以下接口（已在 pai SPECv2 中定义）：

```typescript
import { chat, createBashExecTool, loadConfig, resolveProvider } from 'pai'
```

- `chat(input, config, chunkWriter, tools, signal, maxTurns)` — 核心调用
- `createBashExecTool()` — 创建 bash_exec tool
- `loadConfig(configPath?)` — 加载 pai 配置
- `resolveProvider(config, providerName?)` — 解析 provider + apiKey

xar 在 daemon 启动时加载一次 pai config，缓存在内存中，避免每次消息处理都读文件。

---

## 系统 Agent

系统预置以下 agent，通过 `xar init` 初始化：

| agent_id | kind | 职责 |
|----------|------|------|
| `admin` | system | 面向用户的主 agent，处理日常交互和 agent 管理 |
| `warden` | system | 安全/审计/合规，监控系统行为 |
| `maintainer` | system | 系统升级和维护 |
| `evolver` | system | 自我迭代/学习/优化 |

---

## 错误处理

### Run-loop 错误策略

| 错误类型 | 处理方式 |
|---------|---------|
| LLM 调用失败（网络/超时/rate limit） | 指数退避重试，最多 `retry.max_attempts` 次 |
| LLM 调用失败（认证/策略违反） | 不重试，写 `record/error` 事件到 thread，继续下一条消息 |
| thread lib 操作失败 | 写 daemon 日志，继续下一条消息 |
| memory 更新失败 | 写 daemon 日志，不影响 run-loop |
| IPC 连接断开（xgw 断线） | 写 daemon 日志，消息处理继续（回复丢失，但 thread 中有记录） |

### Daemon 错误策略

| 错误类型 | 处理方式 |
|---------|---------|
| IPC Server 启动失败 | 写日志，daemon 退出（退出码 1） |
| Agent 配置加载失败 | 跳过该 agent，写日志，继续启动其他 agent |
| 未捕获异常 | 写日志，daemon 退出（退出码 1），PID 文件清理 |

---

## 日志

### Daemon 日志

文件：`~/.theclaw/logs/xar.log`

记录内容：
- Daemon 启动/停止
- IPC Server 启动/停止，连接建立/断开
- Agent run-loop 启动/停止
- 消息入队/出队（含 agent_id、source）
- 错误和异常

### Agent 日志

文件：`~/.theclaw/logs/agent-<id>.log`（由 `createFireAndForgetLogger` 管理）

记录内容：
- 消息处理开始/完成（含 thread 路由结果）
- LLM 调用状态（重试次数、错误）
- Session compact 触发/完成
- 出站投递状态

日志轮换：超过 10000 行时自动轮换（与其他 repo 一致）。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | TheClaw 数据根目录 | `~/.theclaw` |
| `XAR_IPC_PORT` | TCP fallback 端口 | `18792` |
| `XAR_LOG_LEVEL` | 日志级别（`debug`/`info`/`warn`/`error`） | `info` |

---

## 错误码

| Code | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 运行时错误（daemon 未运行、agent 不存在、IPC 错误等） |
| `2` | 参数/用法错误（缺少必填参数、非法参数值等） |

---

## 依赖关系

```
xar
├── thread (npm dependency, lib 接口)
├── pai    (npm dependency, lib 接口)
└── ws     (WebSocket 库)
```

xar 不依赖 notifier、xgw、cmds 等其他 repo。

---

## 实施顺序

根据 TheClaw SPECv2.md D7 决策：

1. **thread SPECv2**：基于本文档的 thread lib 接口需求，定义 thread 的 lib 层（`ThreadStore`、`ThreadLib`）
2. **thread 改造**：实施 thread CLI/LIB 双接口改造
3. **xar 核心实施**：
   - Phase 1：IPC Server + 消息队列 + daemon 管理（不含 LLM）
   - Phase 2：run-loop + thread lib 集成（不含 LLM）
   - Phase 3：pai lib 集成 + streaming 投递
   - Phase 4：memory 管理
4. **xgw 升级**：替换 CLI 调用为 IPC 通信
