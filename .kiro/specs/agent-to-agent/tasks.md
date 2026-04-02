# Implementation Plan: Agent-to-Agent Internal Communication

## Overview

按照设计文档，分两个 repo 实施修改：先改 pai（`createBashExecTool` extraEnv 支持），再改 xar（router、turn、run-loop、send、测试）。

## Tasks

- [x] 1. pai: createBashExecTool 支持 extraEnv
  - [x] 1.1 修改 `pai/src/tools/bash-exec.ts`，为 `createBashExecTool()` 添加可选参数 `extraEnv?: Record<string, string>`
    - `spawn` 调用时：`env: extraEnv ? { ...process.env, ...extraEnv } : undefined`
    - `env: undefined` 保持向后兼容（Node.js 默认继承 `process.env`）
    - _Requirements: 4.1_
  - [x] 1.2 在 pai repo 编写单元测试验证 extraEnv 注入
    - 传入 `extraEnv: { TEST_VAR: 'hello' }`，执行 `echo $TEST_VAR`，验证 stdout 包含 `hello`
    - _Requirements: 4.1_

- [x] 2. xar: router 新增 extractConvId
  - [x] 2.1 在 `src/agent/router.ts` 新增导出函数 `extractConvId(source: string): string`
    - internal source：返回 `conversation_id`（第三段）
    - external source：返回 `conversation_id` 字段
    - `self` 或解析失败：返回空字符串 `''`
    - _Requirements: 4.5_
  - [x] 2.2 在 `vitest/unit/router.test.ts` 补充 `extractConvId` 的单元测试
    - 覆盖 internal source、external source、`self`、格式错误的情况
    - _Requirements: 4.5_

- [x] 3. xar: processTurn 支持 extraEnv
  - [x] 3.1 修改 `src/agent/turn.ts`，在 `TurnParams` 接口新增 `extraEnv?: Record<string, string> | undefined`
    - 将 `createBashExecTool()` 调用改为 `createBashExecTool(extraEnv)`
    - _Requirements: 4.2_

- [x] 4. xar: run-loop 传入 extraEnv 并明确处理 internal source
  - [x] 4.1 修改 `src/agent/run-loop.ts` 的 `processMessage()`
    - 调用 `processTurn` 前构造 `extraEnv: { XAR_AGENT_ID: this.agentId, XAR_CONV_ID: extractConvId(msg.source) }`
    - 传入 `processTurn({ ..., extraEnv })`
    - _Requirements: 4.3_
  - [x] 4.2 修改 `processMessage()` 中的 "no connection" warning 逻辑
    - 解析 `msg.source` 的 kind，仅当 `kind !== 'internal'` 时才记录 warning
    - 确认 internal source 的 stream_id 格式为 `internal:<agentId>:<seq>`（已有实现，验证正确）
    - _Requirements: 3.4, 3.5_
  - [x] 4.3 在 `vitest/unit/run-loop.test.ts` 补充 internal source 行为测试
    - `buildTarget()` 对 internal source 返回 `null`
    - 处理 internal source 消息时不触发 "no connection" warning
    - _Requirements: 3.1, 3.4_

- [x] 5. xar: xar send 支持 internal source 自动构造
  - [x] 5.1 修改 `src/commands/send.ts`
    - 移除 `--source` 的默认值 `'external:cli:default:dm:cli:cli'`，改为 `undefined`
    - 新增 `buildInternalSource(opts)` 函数：`--source` 显式提供时直通；否则从 `XAR_AGENT_ID` / `XAR_CONV_ID` 构造 `internal:agent:<convId>:<agentId>`；两者都缺失时 exit 2
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 5.2 新增 `vitest/unit/send.test.ts`
    - `buildInternalSource()` 在 env 变量设置时的正确构造
    - `buildInternalSource()` 在 `--source` 显式提供时的直通行为
    - `buildInternalSource()` 在 env 变量缺失时抛出 CliError（exitCode 2）
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 6. Checkpoint — 确保所有测试通过
  - 运行 `npm test`，确保所有测试通过，如有问题请告知。

- [x] 7. xar: 属性测试
  - [x] 7.1 新增 `vitest/pbt/agent-to-agent.pbt.test.ts`，实现 5 个 correctness properties
    - **Property 1**: Internal source round-trip parsing — 生成随机 (conv_type, conv_id, sender_id)，构造 → 解析 → 字段匹配
      - Tag: `Feature: agent-to-agent, Property 1: internal source round-trip parsing`
      - _Requirements: 1.1_
    - **Property 2**: Invalid internal source always throws — 生成 1-3 段的 `internal:` 前缀字符串，验证 `parseSource()` 抛出
      - Tag: `Feature: agent-to-agent, Property 2: invalid internal source always throws`
      - _Requirements: 1.2_
    - **Property 3**: Internal source thread routing correctness and determinism — 随机 internal source + 路由模式，验证 thread ID 格式正确且两次调用结果相同
      - Tag: `Feature: agent-to-agent, Property 3: internal source thread routing`
      - _Requirements: 2.1, 2.2, 2.3, 2.4_
    - **Property 4**: extraEnv values flow correctly — 随机 agentId + source，验证 `XAR_AGENT_ID` 和 `XAR_CONV_ID` 值正确
      - Tag: `Feature: agent-to-agent, Property 4: extraEnv values flow correctly`
      - _Requirements: 4.3, 4.5_
    - **Property 5**: xar send internal source construction — 随机 agentId + convId，验证构造结果可被 `parseSource()` 解析且字段匹配
      - Tag: `Feature: agent-to-agent, Property 5: xar send internal source construction`
      - _Requirements: 5.1_
    - 每个属性测试最少运行 100 次（`numRuns: 100`）

- [x] 8. Final Checkpoint — 确保所有测试通过
  - 运行 `npm test`，确保所有测试通过，如有问题请告知。

## Notes

- pai repo 的修改（Task 1）需要先完成，xar 的后续任务依赖 pai 的新接口
- `extractConvId` 对解析失败的情况静默返回空字符串，不抛出异常
- `xar send` 的 `--source` 显式参数优先级最高，保持向后兼容（测试/调试场景）
- Property 3 同时验证正确性和确定性，合并了 Requirements 2.1-2.4
