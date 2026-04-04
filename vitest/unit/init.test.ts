import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// We test the init command logic by mocking getDaemonConfig and the pai import,
// then invoking the command action directly via the Command object.

describe('createInitCommand', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `xar-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(join(tmpHome, 'agents'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function runInit(id: string, opts: { provider?: string; model?: string; kind?: string } = {}) {
    // Mock getDaemonConfig to use our temp dir
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 28213, logLevel: 'info' }),
    }))
    // Mock pai so we don't need real config
    vi.doMock('pai', () => ({
      initPai: async () => ({
        getProviderInfo: async () => ({ name: opts.provider ?? 'openai', defaultModel: opts.model ?? 'gpt-4o' }),
      }),
    }))
    // Mock thread lib
    vi.doMock('../../src/agent/thread-lib.js', () => ({
      getThreadLib: () => ({
        init: async () => ({}),
      }),
    }))

    const { createInitCommand } = await import('../../src/commands/init.js')
    const cmd = createInitCommand()

    // Parse args to trigger action
    const args = ['node', 'xar', id]
    if (opts.kind) args.push('--kind', opts.kind)
    if (opts.provider) args.push('--provider', opts.provider)
    if (opts.model) args.push('--model', opts.model)

    cmd.exitOverride()
    await cmd.parseAsync(args)
  }

  it('creates agent directory structure', async () => {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('pai', () => ({
      initPai: async () => ({
        getProviderInfo: async () => ({ name: 'openai', defaultModel: 'gpt-4o' }),
      }),
    }))
    vi.doMock('../../src/agent/thread-lib.js', () => ({
      getThreadLib: () => ({ init: async () => ({}) }),
    }))

    const { createInitCommand } = await import('../../src/commands/init.js')
    const cmd = createInitCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'xar', 'myagent', '--provider', 'openai', '--model', 'gpt-4o'])

    const agentDir = join(tmpHome, 'agents', 'myagent')
    for (const sub of ['sessions', 'memory', 'workdir', 'logs']) {
      const stat = await fs.stat(join(agentDir, sub))
      expect(stat.isDirectory()).toBe(true)
    }
  })

  it('creates config.json with correct fields', async () => {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('pai', () => ({
      initPai: async () => ({
        getProviderInfo: async () => ({ name: 'anthropic', defaultModel: 'claude-3-5-sonnet' }),
      }),
    }))
    vi.doMock('../../src/agent/thread-lib.js', () => ({
      getThreadLib: () => ({ init: async () => ({}) }),
    }))

    const { createInitCommand } = await import('../../src/commands/init.js')
    const cmd = createInitCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'xar', 'agent2', '--provider', 'anthropic', '--model', 'claude-3-5-sonnet'])

    const configPath = join(tmpHome, 'agents', 'agent2', 'config.json')
    const raw = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(raw)

    expect(config.agent_id).toBe('agent2')
    expect(config.kind).toBe('user')
    expect(config.pai.provider).toBe('anthropic')
    expect(config.pai.model).toBe('claude-3-5-sonnet')
    expect(config.routing).toBeDefined()
    expect(config.memory).toBeDefined()
    expect(config.retry).toBeDefined()
  })

  it('creates IDENTITY.md and USAGE.md', async () => {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('pai', () => ({
      initPai: async () => ({
        getProviderInfo: async () => ({ name: 'openai', defaultModel: 'gpt-4o' }),
      }),
    }))
    vi.doMock('../../src/agent/thread-lib.js', () => ({
      getThreadLib: () => ({ init: async () => ({}) }),
    }))

    const { createInitCommand } = await import('../../src/commands/init.js')
    const cmd = createInitCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'xar', 'agent3', '--provider', 'openai', '--model', 'gpt-4o'])

    const agentDir = join(tmpHome, 'agents', 'agent3')
    const identity = await fs.readFile(join(agentDir, 'IDENTITY.md'), 'utf-8')
    const usage = await fs.readFile(join(agentDir, 'USAGE.md'), 'utf-8')

    // IDENTITY.md is a generic template — agent id is injected at runtime via
    // buildCommunicationContext(), not hardcoded into the file.
    expect(identity.length).toBeGreaterThan(0)
    expect(identity).toContain('Role')
    // USAGE.md is agent-specific and contains the id
    expect(usage).toContain('agent3')
  })
})
