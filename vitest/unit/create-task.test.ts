/**
 * Unit tests for create_task tool
 * Requirements: 1.4, 2.1, 2.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskManager } from '../../src/agent/task-manager.js'
import { createCreateTaskTool } from '../../src/agent/create-task.js'
import type { InboundMessage } from '../../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_ID = 'orchestrator'

function makeDeps(
  taskManager: TaskManager,
  sendToAgent: (agentId: string, msg: InboundMessage) => Promise<void>,
) {
  return {
    taskManager,
    agentId: AGENT_ID,
    originThreadId: 'peers/alice',
    originEventId: 1,
    replyTarget: 'peer:alice',
    sendToAgent,
  }
}

let tmpDir: string
let manager: TaskManager

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'create-task-unit-'))
  manager = new TaskManager(AGENT_ID, tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── Normal case ───────────────────────────────────────────────────────────────

describe('create_task handler — normal case', () => {
  it('creates task and returns { task_id, status }', async () => {
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCreateTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    const result = (await tool.handler({
      subtasks: [{ worker: 'agent:worker-1', instruction: 'do work' }],
      wait_all: true,
    })) as { task_id: string; status: string }

    expect(result.task_id).toBeTruthy()
    expect(result.status).toBe('waiting')
  })

  it('sendToAgent is called once per subtask', async () => {
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCreateTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({
      subtasks: [
        { worker: 'agent:worker-1', instruction: 'task A' },
        { worker: 'agent:worker-2', instruction: 'task B' },
        { worker: 'agent:worker-3', instruction: 'task C' },
      ],
      wait_all: true,
    })

    expect(sent).toHaveLength(3)
    expect(sent.map((s) => s.agentId)).toEqual(['worker-1', 'worker-2', 'worker-3'])
  })

  it('delegation message has reply_to set to agent:<agentId>', async () => {
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCreateTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({
      subtasks: [{ worker: 'agent:worker-1', instruction: 'do work' }],
      wait_all: true,
    })

    expect(sent[0]!.msg.reply_to).toBe(`agent:${AGENT_ID}`)
  })

  it('delegation message source starts with internal:task:', async () => {
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCreateTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({
      subtasks: [{ worker: 'agent:worker-1', instruction: 'do work' }],
      wait_all: true,
    })

    expect(sent[0]!.msg.source).toMatch(/^internal:task:/)
  })

  it('wait_all=true → status is "waiting"', async () => {
    const tool = createCreateTaskTool(makeDeps(manager, async () => {}))

    const result = (await tool.handler({
      subtasks: [{ worker: 'agent:worker-1', instruction: 'go' }],
      wait_all: true,
    })) as { task_id: string; status: string }

    expect(result.status).toBe('waiting')
  })

  it('wait_all=false → status is "pending"', async () => {
    const tool = createCreateTaskTool(makeDeps(manager, async () => {}))

    const result = (await tool.handler({
      subtasks: [{ worker: 'agent:worker-1', instruction: 'go' }],
      wait_all: false,
    })) as { task_id: string; status: string }

    expect(result.status).toBe('pending')
  })

  it('worker address without "agent:" prefix is also accepted', async () => {
    const sent: Array<{ agentId: string; msg: InboundMessage }> = []
    const tool = createCreateTaskTool(
      makeDeps(manager, async (agentId, msg) => {
        sent.push({ agentId, msg })
      }),
    )

    await tool.handler({
      subtasks: [{ worker: 'worker-bare', instruction: 'bare worker' }],
      wait_all: false,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.agentId).toBe('worker-bare')
  })
})

// ── sendToAgent failure ───────────────────────────────────────────────────────

describe('create_task handler — sendToAgent failure', () => {
  it('sendToAgent throws → error propagates', async () => {
    const tool = createCreateTaskTool(
      makeDeps(manager, async () => {
        throw new Error('network error')
      }),
    )

    await expect(
      tool.handler({
        subtasks: [{ worker: 'agent:worker-1', instruction: 'go' }],
        wait_all: true,
      }),
    ).rejects.toThrow('network error')
  })
})
