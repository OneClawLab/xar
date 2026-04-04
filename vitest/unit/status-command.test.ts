import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('createStatusCommand', () => {
  let tmpHome: string
  let stdoutOutput: string
  let stderrOutput: string
  let exitCode: number | undefined

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `xar-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(join(tmpHome, 'agents'), { recursive: true })
    stdoutOutput = ''
    stderrOutput = ''
    exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation((s) => { stdoutOutput += String(s) + '\n' })
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { stderrOutput += s; return true })
    vi.spyOn(process, 'exit').mockImplementation((code) => { exitCode = code as number; throw new Error(`exit:${code}`) })
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function getCmd() {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('../../src/daemon/pid.js', () => ({
      checkDaemonRunning: async () => false,
    }))
    vi.doMock('../../src/ipc/client.js', () => ({
      sendIpcMessage: async () => ({ type: 'ok', data: {} }),
    }))
    vi.doMock('../../src/agent/thread-lib.js', () => ({
      getThreadLib: () => ({
        open: async () => ({ peek: async () => [] }),
      }),
    }))
    const { createStatusCommand } = await import('../../src/commands/status.js')
    const cmd = createStatusCommand()
    cmd.exitOverride()
    return cmd
  }

  async function createAgent(id: string, kind = 'user') {
    const agentDir = join(tmpHome, 'agents', id)
    await fs.mkdir(join(agentDir, 'sessions'), { recursive: true })
    await fs.mkdir(join(agentDir, 'memory'), { recursive: true })
    await fs.writeFile(join(agentDir, 'config.json'), JSON.stringify({
      agent_id: id, kind,
      pai: { provider: 'openai', model: 'gpt-4o' },
      routing: { default: 'per-peer' },
      memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
      retry: { max_attempts: 3 },
    }))
  }

  it('exits 1 when specified agent id does not exist', async () => {
    const cmd = await getCmd()
    await expect(cmd.parseAsync(['node', 'xar', 'nonexistent'])).rejects.toThrow('exit:1')
    expect(exitCode).toBe(1)
  })

  it('--json output contains agent_id field', async () => {
    await createAgent('myagent')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar', 'myagent', '--json'])
    const parsed = JSON.parse(stdoutOutput.trim())
    expect(parsed).toHaveProperty('agent_id', 'myagent')
  })

  it('lists all agents when no id argument given', async () => {
    await createAgent('alpha')
    await createAgent('beta')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar'])
    expect(stdoutOutput).toContain('alpha')
    expect(stdoutOutput).toContain('beta')
  })

  it('shows static info even when daemon is not running', async () => {
    await createAgent('offline')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar', 'offline'])
    expect(stdoutOutput).toContain('offline')
  })
})
