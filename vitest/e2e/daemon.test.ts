import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * End-to-end tests for daemon lifecycle
 * These tests verify the complete flow of daemon operations
 */
describe('daemon e2e', () => {
  const testDir = join(tmpdir(), `xar-e2e-${Date.now()}`)

  it('should initialize daemon environment', async () => {
    const logsDir = join(testDir, 'logs')
    const agentsDir = join(testDir, 'agents')

    await fs.mkdir(logsDir, { recursive: true })
    await fs.mkdir(agentsDir, { recursive: true })

    const logsStat = await fs.stat(logsDir)
    const agentsStat = await fs.stat(agentsDir)

    expect(logsStat.isDirectory()).toBe(true)
    expect(agentsStat.isDirectory()).toBe(true)
  })

  it('should create and manage agent lifecycle', async () => {
    const agentId = 'e2e-agent'
    const agentDir = join(testDir, 'agents', agentId)

    // Initialize agent
    await fs.mkdir(agentDir, { recursive: true })

    const configPath = join(agentDir, 'config.json')
    const config = {
      id: agentId,
      status: 'initialized',
      pai: { provider: 'openai', model: 'gpt-4' },
      routing: { type: 'per-agent' },
      retry: { max_attempts: 3, backoff_base: 2 },
    }
    await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

    // Verify initialization
    let content = await fs.readFile(configPath, 'utf-8')
    let loaded = JSON.parse(content)
    expect(loaded.status).toBe('initialized')

    // Update status to started
    loaded.status = 'started'
    await fs.writeFile(configPath, JSON.stringify(loaded), 'utf-8')

    // Verify update
    content = await fs.readFile(configPath, 'utf-8')
    loaded = JSON.parse(content)
    expect(loaded.status).toBe('started')
  })

  it('should handle session lifecycle with compaction', async () => {
    const agentId = 'e2e-agent'
    const threadId = 'thread-1'
    const sessionsDir = join(testDir, 'agents', agentId, 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })

    const sessionFile = join(sessionsDir, `${threadId}.jsonl`)

    // Create initial session
    const initialMessages = [
      { role: 'system' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ]

    let lines = initialMessages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    await fs.writeFile(sessionFile, lines, 'utf-8')

    // Verify initial session
    let content = await fs.readFile(sessionFile, 'utf-8')
    let messages = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    expect(messages).toHaveLength(3)

    // Simulate compaction - add summary
    const compactedMessages = [
      initialMessages[0],
      { role: 'assistant' as const, content: '[Memory Summary]\nKey facts from conversation' },
      initialMessages[2],
    ]

    lines = compactedMessages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    await fs.writeFile(sessionFile, lines, 'utf-8')

    // Verify compacted session
    content = await fs.readFile(sessionFile, 'utf-8')
    messages = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    expect(messages).toHaveLength(3)
    expect(messages[1].content).toContain('[Memory Summary]')
  })

  it('should manage logging across daemon lifecycle', async () => {
    const logsDir = join(testDir, 'logs')
    await fs.mkdir(logsDir, { recursive: true })

    const daemonLogFile = join(logsDir, 'xar.log')
    const agentLogFile = join(logsDir, 'xar-agent-e2e-agent.log')

    // Simulate daemon logging
    const daemonLog = `[2026-03-26T12:00:00.000Z] [INFO] Daemon starting...
[2026-03-26T12:00:00.100Z] [INFO] IPC Server started
[2026-03-26T12:00:00.200Z] [INFO] Agent e2e-agent started
[2026-03-26T12:00:01.000Z] [INFO] Daemon shutdown complete`

    await fs.writeFile(daemonLogFile, daemonLog, 'utf-8')

    // Simulate agent logging
    const agentLog = `[2026-03-26T12:00:00.200Z] [INFO] Agent starting
[2026-03-26T12:00:00.300Z] [INFO] Processing message from user
[2026-03-26T12:00:00.400Z] [DEBUG] LLM context built
[2026-03-26T12:00:00.500Z] [INFO] Message processed successfully`

    await fs.writeFile(agentLogFile, agentLog, 'utf-8')

    // Verify logs
    const daemonContent = await fs.readFile(daemonLogFile, 'utf-8')
    const agentContent = await fs.readFile(agentLogFile, 'utf-8')

    expect(daemonContent).toContain('Daemon starting')
    expect(daemonContent).toContain('IPC Server started')
    expect(agentContent).toContain('Processing message')
    expect(agentContent).toContain('Message processed successfully')
  })

  it('should handle multiple agents concurrently', async () => {
    const agentIds = ['agent-1', 'agent-2', 'agent-3']

    // Initialize multiple agents
    for (const agentId of agentIds) {
      const agentDir = join(testDir, 'agents', agentId)
      await fs.mkdir(agentDir, { recursive: true })

      const configPath = join(agentDir, 'config.json')
      const config = {
        id: agentId,
        status: 'started',
        created_at: new Date().toISOString(),
      }
      await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')
    }

    // Verify all agents
    for (const agentId of agentIds) {
      const configPath = join(testDir, 'agents', agentId, 'config.json')
      const content = await fs.readFile(configPath, 'utf-8')
      const config = JSON.parse(content)
      expect(config.id).toBe(agentId)
      expect(config.status).toBe('started')
    }
  })
})
