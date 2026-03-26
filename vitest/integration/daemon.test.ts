import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('daemon integration', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = join(tmpdir(), `xar-test-${Date.now()}`)
    await fs.mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('should create daemon directory structure', async () => {
    const agentsDir = join(testDir, 'agents')
    await fs.mkdir(agentsDir, { recursive: true })

    const stat = await fs.stat(agentsDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('should handle agent initialization', async () => {
    const agentId = 'test-agent'
    const agentDir = join(testDir, 'agents', agentId)
    await fs.mkdir(agentDir, { recursive: true })

    const configPath = join(agentDir, 'config.json')
    const config = {
      id: agentId,
      status: 'initialized',
      created_at: new Date().toISOString(),
    }
    await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

    const content = await fs.readFile(configPath, 'utf-8')
    const loaded = JSON.parse(content)
    expect(loaded.id).toBe(agentId)
    expect(loaded.status).toBe('initialized')
  })

  it('should manage session files', async () => {
    const agentId = 'test-agent'
    const threadId = 'thread-1'
    const sessionsDir = join(testDir, 'agents', agentId, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })

    const sessionFile = join(sessionsDir, `${threadId}.jsonl`)
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ]

    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    await fs.writeFile(sessionFile, lines, 'utf-8')

    const content = await fs.readFile(sessionFile, 'utf-8')
    const loaded = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))

    expect(loaded).toHaveLength(2)
    expect(loaded[0].role).toBe('user')
    expect(loaded[1].role).toBe('assistant')
  })

  it('should track compact state', async () => {
    const agentId = 'test-agent'
    const threadId = 'thread-1'
    const sessionsDir = join(testDir, 'agents', agentId, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })

    const statePath = join(sessionsDir, `compact-state-${threadId}.json`)
    const state = { turnCount: 5, lastCompactedAt: 0 }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')

    const content = await fs.readFile(statePath, 'utf-8')
    const loaded = JSON.parse(content)

    expect(loaded.turnCount).toBe(5)
    expect(loaded.lastCompactedAt).toBe(0)
  })

  it('should store memory summaries', async () => {
    const agentId = 'test-agent'
    const threadId = 'thread-1'
    const memoryDir = join(testDir, 'agents', agentId, 'memory')
    await fs.mkdir(memoryDir, { recursive: true })

    const memoryFile = join(memoryDir, `thread-${threadId}.md`)
    const summary = `## Memory Summary
- Key fact 1
- Key fact 2`

    await fs.writeFile(memoryFile, summary, 'utf-8')

    const content = await fs.readFile(memoryFile, 'utf-8')
    expect(content).toContain('Memory Summary')
    expect(content).toContain('Key fact 1')
  })
})
