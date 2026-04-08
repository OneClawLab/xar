/**
 * Unit tests for spawn_adhoc_task tool
 */

import { describe, it, expect } from 'vitest'
import { createSpawnAdhocTaskTool } from '../../src/agent/tasks/spawn-adhoc-task.js'
import type { SpawnAdhocTaskToolDeps } from '../../src/agent/tasks/spawn-adhoc-task.js'
import type { Pai } from 'pai'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Pai whose chat() yields a single chat_end event with the given reply */
function makePai(reply: string): Pai {
  return {
    chat: async function* (_input: unknown, _opts: unknown) {
      yield {
        type: 'chat_end',
        newMessages: [{ role: 'assistant', content: reply }],
      }
    },
  } as unknown as Pai
}

/** Build a mock Pai whose chat() yields no chat_end event */
function makePaiNoEnd(): Pai {
  return {
    chat: async function* (_input: unknown, _opts: unknown) {
      yield { type: 'chat_start' }
    },
  } as unknown as Pai
}

function makeDeps(pai: Pai): SpawnAdhocTaskToolDeps {
  return { pai, provider: 'test-provider', model: 'test-model' }
}

// ── Normal cases ──────────────────────────────────────────────────────────────

describe('spawn_adhoc_task handler — normal cases', () => {
  it('returns result from assistant message', async () => {
    const tool = createSpawnAdhocTaskTool(makeDeps(makePai('hello world')))
    const out = await tool.handler({ instruction: 'say hello' })
    expect(out).toEqual({ result: 'hello world' })
  })

  it('instruction only — userContent equals instruction', async () => {
    let capturedInput: unknown
    const pai = {
      chat: async function* (input: unknown) {
        capturedInput = input
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'ok' }] }
      },
    } as unknown as Pai

    const tool = createSpawnAdhocTaskTool(makeDeps(pai))
    await tool.handler({ instruction: 'do the thing' })
    expect((capturedInput as { userMessage: string }).userMessage).toBe('do the thing')
  })

  it('context + instruction — userContent is context\\n\\ninstruction', async () => {
    let capturedInput: unknown
    const pai = {
      chat: async function* (input: unknown) {
        capturedInput = input
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'ok' }] }
      },
    } as unknown as Pai

    const tool = createSpawnAdhocTaskTool(makeDeps(pai))
    await tool.handler({ instruction: 'summarize', context: 'some data' })
    expect((capturedInput as { userMessage: string }).userMessage).toBe('some data\n\nsummarize')
  })

  it('trims whitespace from assistant reply', async () => {
    const tool = createSpawnAdhocTaskTool(makeDeps(makePai('  trimmed  ')))
    const out = await tool.handler({ instruction: 'go' })
    expect(out).toEqual({ result: 'trimmed' })
  })

  it('passes provider and model to pai.chat options', async () => {
    let capturedOpts: unknown
    const pai = {
      chat: async function* (_input: unknown, opts: unknown) {
        capturedOpts = opts
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'x' }] }
      },
    } as unknown as Pai

    const tool = createSpawnAdhocTaskTool({ pai, provider: 'my-provider', model: 'my-model' })
    await tool.handler({ instruction: 'go' })
    expect(capturedOpts).toMatchObject({ provider: 'my-provider', model: 'my-model', stream: false })
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('spawn_adhoc_task handler — edge cases', () => {
  it('no chat_end event → result is empty string', async () => {
    const tool = createSpawnAdhocTaskTool(makeDeps(makePaiNoEnd()))
    const out = await tool.handler({ instruction: 'go' })
    expect(out).toEqual({ result: '' })
  })

  it('assistant content is empty string → result is empty string', async () => {
    const tool = createSpawnAdhocTaskTool(makeDeps(makePai('   ')))
    const out = await tool.handler({ instruction: 'go' })
    expect(out).toEqual({ result: '' })
  })

  it('non-assistant messages in chat_end are ignored', async () => {
    const pai = {
      chat: async function* (_input: unknown, _opts: unknown) {
        yield {
          type: 'chat_end',
          newMessages: [
            { role: 'user', content: 'user msg' },
            { role: 'assistant', content: 'real answer' },
          ],
        }
      },
    } as unknown as Pai

    const tool = createSpawnAdhocTaskTool(makeDeps(pai))
    const out = await tool.handler({ instruction: 'go' })
    expect(out).toEqual({ result: 'real answer' })
  })

  it('tool metadata: name is spawn_adhoc_task', () => {
    const tool = createSpawnAdhocTaskTool(makeDeps(makePai('x')))
    expect(tool.name).toBe('spawn_adhoc_task')
  })
})
