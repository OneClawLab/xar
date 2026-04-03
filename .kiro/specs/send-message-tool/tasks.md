# 实施计划：send_message Tool

## 概述

基于设计文档，将 send_message tool、Communication Context 注入、出站模型重构分解为增量编码任务。每个任务构建在前一个任务之上，确保无孤立代码。

## Tasks

- [x] 1. 实现 send_message tool 核心模块
  - [x] 1.1 创建 `src/agent/send-message.ts`，实现 `createSendMessageTool` 工厂函数
    - 实现 `splitTarget(target)` 辅助函数，解析 target 为 `[prefix, id]`
    - 实现 `findPeerSource(events, peerId)` 辅助函数，从 thread events 中查找指定 peer 最近的 external source
    - 实现 `deliverToPeer(deps, peerId, content)` 函数：扫描 thread → 解析 OutboundTarget → stream_start/token/end → 写 record → 返回 status
    - 实现 `deliverToAgent(deps, agentId, content)` 函数：构造 internal source → sendToAgent → 写 record → 返回 status
    - 实现 handler 主逻辑：根据 target 前缀分发到 deliverToPeer 或 deliverToAgent，无效格式返回 error
    - Tool schema 包含 name='send_message'、description、parameters（target + content required）
    - 所有错误通过返回值传递，不抛异常
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.3, 6.1, 6.2, 6.3_

  - [-]* 1.2 编写 send_message 属性测试 `vitest/pbt/send-message.pbt.test.ts`
    - **Property 1: findPeerSource 返回最近的 external source**
    - **Validates: Requirements 1.2**
    - **Property 2: 成功投递写入 record 并返回 delivered**
    - **Validates: Requirements 1.5, 1.6**
    - **Property 3: 无效 target 格式返回 error**
    - **Validates: Requirements 1.7**
    - **Property 4: internal source 地址构造格式正确**
    - **Validates: Requirements 1.4**
    - **Property 8: stream_id 格式遵循约定**
    - **Validates: Requirements 6.3**

  - [ ]* 1.3 编写 send_message 单元测试 `vitest/unit/send-message.test.ts`
    - Tool schema 结构验证（name、parameters）
    - peer 投递完整 IPC 序列验证（stream_start → stream_token → stream_end）
    - agent 投递 sendToAgent 调用验证
    - peer not found edge case
    - agent not running edge case
    - IPC 连接不可用 edge case
    - _Requirements: 1.1, 1.3, 1.4, 1.7, 1.8, 1.9_

- [x] 2. 实现 Communication Context 注入
  - [x] 2.1 修改 `src/agent/context.ts`，新增 `buildCommunicationContext` 函数
    - 根据 parseSource 结果判断 external/internal
    - External DM：生成 agent 身份、会话类型、渠道、peer、streaming 提示
    - External Group：额外扫描 thread events 提取 recent participants
    - Internal：生成 agent 身份、来源 agent、NOT auto-delivered 提示、send_message 回复示例
    - 附加 available agents 列表（排除自身）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.2 修改 `buildContext` 函数签名，新增 `availableAgents?: string[]` 参数
    - 在 system prompt 末尾追加 Communication Context
    - _Requirements: 3.1_

  - [ ]* 2.3 编写 Communication Context 属性测试 `vitest/pbt/communication-context.pbt.test.ts`
    - **Property 5: external 消息的 Communication Context 包含必要字段**
    - **Validates: Requirements 3.2, 3.4**
    - **Property 6: internal 消息的 Communication Context 包含必要字段**
    - **Validates: Requirements 3.3, 3.4**
    - **Property 7: group 会话的 Communication Context 包含 recent participants**
    - **Validates: Requirements 3.5**

  - [ ]* 2.4 编写 Communication Context 单元测试 `vitest/unit/communication-context.test.ts`
    - DM 场景完整输出验证
    - Group 场景完整输出验证
    - Internal 场景完整输出验证
    - 空 agent 列表 edge case
    - _Requirements: 3.2, 3.3, 3.5_

- [x] 3. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 4. 修改 run-loop：移除 auto-reply、抑制 internal 出站、集成 send_message
  - [x] 4.1 移除 `run-loop.ts` 中 processMessage 末尾的 agent-to-agent auto-reply 代码块
    - 删除从 `const parsedSource = parseSource(msg.source)` 到 auto-reply 结束的代码
    - _Requirements: 4.1, 4.2_

  - [x] 4.2 修改 `run-loop.ts` 中 internal 消息的隐式出站抑制逻辑
    - 当 `isInternal` 为 true 时，不创建 Deliver 和 IpcChunkWriter
    - 确保 LLM response 仍写入 thread
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 4.3 在 `run-loop.ts` 的 processMessage 中集成 send_message tool
    - import createSendMessageTool
    - 在 processTurn 调用前创建 send_message tool 实例
    - 通过 extraTools 传入 processTurn
    - _Requirements: 2.2_

  - [x] 4.4 修改 RunLoopImpl 构造函数，新增 `getRunningAgents` 回调参数
    - 在 buildContext 调用时传入 availableAgents
    - _Requirements: 3.4_

  - [x] 4.5 修改 `daemon/index.ts`，在创建 RunLoopImpl 时传入 `getRunningAgents` 回调
    - 回调返回 `Array.from(this.agents.keys())`
    - _Requirements: 3.4_

- [x] 5. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 6. 更新 SPEC.md 文档
  - [x] 6.1 更新 `xar/SPEC.md`
    - 新增 send_message tool 章节（schema、target 格式、执行流程）
    - 新增 Communication Context 注入章节（注入内容、来源、格式示例）
    - 更新出站模型描述（隐式 streaming + 显式 send_message 双出站路径）
    - 更新 agent 间通信描述（移除自动回复，LLM 通过 send_message 显式控制）
    - 更新目录结构（新增 send-message.ts）
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 7. Final checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 每个 task 引用具体的 requirements 编号以确保可追溯性
- Checkpoints 确保增量验证
- Property tests 验证通用正确性属性，unit tests 验证具体示例和 edge cases
