/**
 * Property-based tests for TaskManager
 */

import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskManager } from '../../src/agent/task-manager.js'
import type { CreateTaskParams } from '../../src/agent/task-types.js'

// ── Generators ────────────────────────────────────────────────────────────────

const safeIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)

const subtaskArb = fc.record({
  worker: safeIdArb,
  instruction: fc.string({ minLength: 1, maxLength: 80 }),
})

function createTaskParamsArb(minSubtasks = 1, maxSubtasks = 5): fc.Arbitrary<CreateTaskParams> {
  return fc.record({
    owner: safeIdArb,
    originThreadId: safeIdArb,
    originEventId: fc.nat({ max: 9999 }),
    replyTarget: fc.oneof(
      safeIdArb.map(id => `peer:${id}`),
      safeIdArb.map(id => `agent:${id}`),
    ),
    waitAll: fc.boolean(),
    subtasks: fc.array(subtaskArb, { minLength: minSubtasks, maxLength: maxSubtasks }),
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTempManager(agentId: string): Promise<{ manager: TaskManager; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'task-manager-pbt-'))
  const manager = new TaskManager(agentId, tmpDir)
  return { manager, tmpDir }
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true })
}

// ── Property 1: Task 创建正确性 ───────────────────────────────────────────────
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 11.1, 11.2
describe('Property 1: Task 创建正确性', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await cleanup(d)
  })

  it('createTask returns a Task with correct shape for any valid params', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeIdArb,
        createTaskParamsArb(1, 5),
        async (agentId, params) => {
          const { manager, tmpDir } = await makeTempManager(agentId)
          tmpDirs.push(tmpDir)

          const task = await manager.createTask(params)

          // task_id is non-empty and matches <agentId>-<timestamp>-<random>
          expect(task.task_id).toBeTruthy()
          expect(task.task_id).toMatch(new RegExp(`^${agentId}-\\d+-[a-z0-9]+$`))

          // owner equals passed owner
          expect(task.owner).toBe(params.owner)

          // origin fields are complete
          expect(task.origin.thread_id).toBe(params.originThreadId)
          expect(task.origin.event_id).toBe(params.originEventId)
          expect(task.origin.reply_target).toBe(params.replyTarget)

          // wait_all=true → status='waiting', wait_all=false → status='pending'
          if (params.waitAll) {
            expect(task.status).toBe('waiting')
          } else {
            expect(task.status).toBe('pending')
          }

          // subtasks.length equals input subtasks length
          expect(task.subtasks.length).toBe(params.subtasks.length)

          // each subtask has status='sent'
          for (const st of task.subtasks) {
            expect(st.status).toBe('sent')
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ── Property 2: Task 状态机转换正确性 ─────────────────────────────────────────
// Validates: Requirements 1.6, 1.7, 10.2
describe('Property 2: Task 状态机转换正确性', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await cleanup(d)
  })

  it('handleAnnounce updates subtasks in order and completes task when all terminal', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeIdArb,
        fc.integer({ min: 1, max: 5 }).chain(n =>
          fc.tuple(
            fc.uniqueArray(safeIdArb, { minLength: n, maxLength: n }),
            fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }),
            fc.array(fc.boolean(), { minLength: n, maxLength: n }),
          ).map(([workers, order, failFlags]) => ({ n, workers, order, failFlags })),
        ),
        async (agentId, { n, workers, order, failFlags }) => {
          const { manager, tmpDir } = await makeTempManager(agentId)
          tmpDirs.push(tmpDir)

          const params: CreateTaskParams = {
            owner: agentId,
            originThreadId: 'thread-1',
            originEventId: 1,
            replyTarget: 'peer:human',
            waitAll: true,
            subtasks: workers.map(w => ({ worker: w, instruction: `task for ${w}` })),
          }

          const task = await manager.createTask(params)

          for (let i = 0; i < n; i++) {
            const idx = order[i]!
            const worker = workers[idx]!
            const failed = failFlags[idx]!
            const result = await manager.handleAnnounce(task.task_id, worker, `result-${idx}`, failed)

            if (i < n - 1) {
              expect(result.taskCompleted).toBe(false)
            } else {
              expect(result.taskCompleted).toBe(true)
              expect(result.task.status).toBe('done')
            }

            const st = result.task.subtasks.find(s => s.worker === worker)
            expect(st?.status === 'done' || st?.status === 'failed').toBe(true)
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ── Property 3: Task 持久化 round-trip ────────────────────────────────────────
// Validates: Requirements 1.8
describe('Property 3: Task 持久化 round-trip', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await cleanup(d)
  })

  it('getTask returns the same task that createTask returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeIdArb,
        createTaskParamsArb(1, 5),
        async (agentId, params) => {
          const { manager, tmpDir } = await makeTempManager(agentId)
          tmpDirs.push(tmpDir)

          const created = await manager.createTask(params)
          const retrieved = await manager.getTask(created.task_id)

          expect(retrieved).not.toBeNull()
          expect(retrieved!.task_id).toBe(created.task_id)
          expect(retrieved!.owner).toBe(created.owner)
          expect(retrieved!.status).toBe(created.status)
          expect(retrieved!.subtasks.length).toBe(created.subtasks.length)

          for (let i = 0; i < created.subtasks.length; i++) {
            expect(retrieved!.subtasks[i]!.subtask_id).toBe(created.subtasks[i]!.subtask_id)
            expect(retrieved!.subtasks[i]!.worker).toBe(created.subtasks[i]!.worker)
            expect(retrieved!.subtasks[i]!.status).toBe(created.subtasks[i]!.status)
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ── Property 4: Task 取消正确性 ───────────────────────────────────────────────
// Validates: Requirements 2.1, 2.2, 2.3
describe('Property 4: Task 取消正确性', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await cleanup(d)
  })

  it('cancelTask sets status=cancelled and subsequent announces are discarded', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeIdArb,
        fc.integer({ min: 1, max: 5 }).chain(n =>
          fc.uniqueArray(safeIdArb, { minLength: n, maxLength: n }).map(workers => ({ workers })),
        ),
        async (agentId, { workers }) => {
          const { manager, tmpDir } = await makeTempManager(agentId)
          tmpDirs.push(tmpDir)

          const params: CreateTaskParams = {
            owner: agentId,
            originThreadId: 'thread-1',
            originEventId: 1,
            replyTarget: 'peer:human',
            waitAll: true,
            subtasks: workers.map(w => ({ worker: w, instruction: `task for ${w}` })),
          }

          const task = await manager.createTask(params)

          const cancelResult = await manager.cancelTask(task.task_id)
          expect(cancelResult.cancelled).toBe(true)

          const cancelled = await manager.getTask(task.task_id)
          expect(cancelled!.status).toBe('cancelled')

          expect(await manager.isTaskCancelled(task.task_id)).toBe(true)

          // Subsequent announces must not change status or complete the task
          for (const worker of workers) {
            const announceResult = await manager.handleAnnounce(task.task_id, worker, 'result', false)
            expect(announceResult.taskCompleted).toBe(false)
            expect(announceResult.task.status).toBe('cancelled')
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})
