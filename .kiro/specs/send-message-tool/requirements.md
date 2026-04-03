# 需求文档：send_message Tool

## 简介

为 xar agent 运行时新增 `send_message` LLM tool，使 agent 能够主动向任意 peer（人类）或其他 agent 发送消息。同时注入 Communication Context 到 system prompt，让 LLM 了解当前通信环境和可用目标。移除现有的 agent 间自动回复机制，改为由 LLM 通过 `send_message` 显式控制回复行为。对 internal 消息抑制隐式出站 streaming。

## 术语表

- **send_message**: xar 注册给 LLM 的内置 tool，与 `bash_exec` 并列，用于向指定 target 发送消息
- **Communication_Context**: 注入到 system prompt 中的通信环境信息段，告知 LLM 当前对话性质和可用目标
- **隐式_streaming**: LLM text response 自动 stream 给当前入站消息的 source peer 的默认出站行为
- **显式_send_message**: LLM 主动调用 send_message tool 向指定 target 发送消息的出站行为
- **OutboundTarget**: 出站目标地址结构，包含 channel_id、peer_id、conversation_id
- **internal_message**: source 地址以 `internal:` 开头的 agent 间消息
- **external_message**: source 地址以 `external:` 开头的来自人类 peer 的消息
- **Tool_Executor**: xar 中处理 LLM tool call 的执行器，在 processTurn 的 LLM 调用循环内运行
- **Deliver**: xar 出站投递模块，通过 IPC 向 xgw 发送 streaming 事件
- **IpcChunkWriter**: 将 LLM token 写入 IPC stream 的 Writable 实现

## 需求

### 需求 1：send_message Tool 实现

**用户故事：** 作为 agent，我希望能通过 send_message tool 主动向任意 peer 或 agent 发送消息，以便进行任务分发、中间通知和 agent 间协调。

#### 验收标准

1. THE Tool_Executor SHALL 注册一个名为 `send_message` 的 tool，接受 `target`（string）和 `content`（string）两个必填参数
2. WHEN LLM 调用 send_message 且 target 格式为 `peer:<peer_id>` 时，THE Tool_Executor SHALL 扫描当前 thread 的 recent events 查找该 peer_id 最近的 external source 地址
3. WHEN 找到 peer 的 external source 时，THE Tool_Executor SHALL 从 source 解析出 OutboundTarget，通过 IPC streaming 协议（stream_start → stream_token → stream_end）投递消息
4. WHEN LLM 调用 send_message 且 target 格式为 `agent:<agent_id>` 时，THE Tool_Executor SHALL 构造 internal source 地址 `internal:agent:<conv_id>:<self_agent_id>`，通过 daemon 的 sendToAgent 回调投递消息
5. WHEN send_message 成功投递后，THE Tool_Executor SHALL 向当前 thread 写入一条 record 事件（source='self', type='record', subtype='message'），记录发送内容和目标
6. WHEN send_message 成功投递后，THE Tool_Executor SHALL 返回 `{ status: 'delivered', target }` 给 LLM
7. WHEN target 格式不是 `peer:` 或 `agent:` 前缀时，THE Tool_Executor SHALL 返回 `{ status: 'error', message: 'invalid target format' }` 给 LLM
8. WHEN target 为 `peer:<peer_id>` 但在 thread 中找不到该 peer 的 external source 时，THE Tool_Executor SHALL 返回 `{ status: 'error', message: 'peer not found in thread context' }` 给 LLM
9. WHEN target 为 `agent:<agent_id>` 但目标 agent 未运行时，THE Tool_Executor SHALL 返回 `{ status: 'error', message: 'agent not running' }` 给 LLM

### 需求 2：send_message Tool 注册与传递

**用户故事：** 作为开发者，我希望 send_message tool 通过 extraTools 机制传入 processTurn，以便与现有 tool 执行流程无缝集成。

#### 验收标准

1. THE send_message tool SHALL 作为 pai Tool 接口实现，与 bash_exec 使用相同的 tool 接口
2. WHEN run-loop 调用 processTurn 时，THE run-loop SHALL 将 send_message tool 通过 extraTools 参数传入
3. THE send_message tool 的 schema SHALL 包含 name='send_message'、description（说明用途和使用场景）、以及 parameters（target 和 content 两个 required string 属性）

### 需求 3：Communication Context 注入

**用户故事：** 作为 agent，我希望在每次 LLM 调用时 system prompt 中包含通信环境信息，以便了解当前对话性质、可用目标和回复行为。

#### 验收标准

1. WHEN buildContext 构建 system prompt 时，THE buildContext SHALL 在 system prompt 末尾追加一段 Communication Context 信息
2. WHEN 入站消息来自 external source 时，THE Communication_Context SHALL 包含：agent 身份（agent_id）、会话类型（dm/group）、渠道信息、当前消息来源 peer、以及"Your text response will be streamed to peer:X"的提示
3. WHEN 入站消息来自 internal source 时，THE Communication_Context SHALL 包含：agent 身份、消息来源 agent、以及"Your text response will NOT be auto-delivered — use send_message to reply"的提示
4. THE Communication_Context SHALL 包含当前可用的 agent 列表（从 daemon 运行时状态获取）
5. WHEN 会话类型为 group 时，THE Communication_Context SHALL 包含 recent participants 列表（从当前 thread 的 recent events 中提取不同的 peer_id）

### 需求 4：移除 Agent 间自动回复机制

**用户故事：** 作为系统架构师，我希望移除现有的 agent 间自动回复代码，改为由 LLM 通过 send_message 显式控制回复行为，以便实现更灵活的 agent 间交互模式。

#### 验收标准

1. WHEN agent 处理完 internal 消息后，THE run-loop SHALL 不再自动将 assistant reply 投递回发送方 agent
2. THE run-loop SHALL 移除 processMessage 末尾的 agent-to-agent auto-reply 代码块

### 需求 5：Internal 消息隐式出站抑制

**用户故事：** 作为系统架构师，我希望处理 internal 消息时不创建 Deliver/IpcChunkWriter 用于隐式 streaming，以便 LLM text response 仅写入 thread 而不发送到 xgw。

#### 验收标准

1. WHEN 入站消息来自 internal source 时，THE run-loop SHALL 不创建 Deliver 对象用于隐式 streaming
2. WHEN 入站消息来自 internal source 时，THE run-loop SHALL 不创建 IpcChunkWriter 用于 token streaming
3. WHEN 入站消息来自 internal source 时，THE run-loop SHALL 仍然将 LLM response 写入 thread 作为 record 事件

### 需求 6：send_message 对 peer 的投递协议

**用户故事：** 作为系统架构师，我希望 send_message 对 peer 的投递走标准出站协议（stream_start/token/end），以便 xgw 无法区分这是 send_message 还是隐式 streaming。

#### 验收标准

1. WHEN send_message 向 peer 投递时，THE Tool_Executor SHALL 生成新的 stream_id
2. WHEN send_message 向 peer 投递时，THE Tool_Executor SHALL 依次发送 stream_start（携带 OutboundTarget）、stream_token（携带完整 content）、stream_end
3. THE send_message 的 stream_id 格式 SHALL 遵循 `<channel_id>:<conversation_id>:<seq>` 的约定

### 需求 7：SPEC.md 更新

**用户故事：** 作为开发者，我希望 xar SPEC.md 文档反映 send_message tool、Communication Context 注入和双出站模型的设计，以便新成员理解系统行为。

#### 验收标准

1. WHEN send_message tool 实现完成后，THE SPEC.md SHALL 新增 send_message tool 章节，描述 tool schema、target 格式、执行流程
2. WHEN Communication Context 实现完成后，THE SPEC.md SHALL 新增 Communication Context 注入章节，描述注入内容和来源
3. THE SPEC.md SHALL 更新出站模型描述，说明隐式 streaming 和显式 send_message 的双出站路径
4. THE SPEC.md SHALL 更新 agent 间通信描述，说明移除自动回复后的交互模式
