import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('createDaemonCommand — status subcommand', () => {
  let stdoutOutput: string
  let stderrOutput: string
  let exitCode: number | undefined

  beforeEach(() => {
    stdoutOutput = ''
    stderrOutput = ''
    exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation((s) => { stdoutOutput += String(s) + '\n' })
    vi.spyOn(console, 'error').mockImplementation((s) => { stderrOutput += String(s) + '\n' })
    vi.spyOn(process, 'exit').mockImplementation((code) => { exitCode = code as number; throw new Error(`exit:${code}`) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function getCmd(daemonRunning: boolean, ipcResponse?: { type: string; data?: unknown }) {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: '/tmp/theclaw', ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('../../src/daemon/pid.js', () => ({
      checkDaemonRunning: async () => daemonRunning,
      readPidFile: async () => daemonRunning ? 12345 : null,
      ensureDaemonNotRunning: async () => { if (daemonRunning) throw new Error('already running') },
      deletePidFile: async () => {},
    }))
    vi.doMock('../../src/ipc/client.js', () => ({
      sendIpcMessage: async () => ipcResponse ?? { type: 'ok', data: { pid: 12345, uptime: 60, agents: [] } },
    }))
    const { createDaemonCommand } = await import('../../src/commands/daemon.js')
    const cmd = createDaemonCommand()
    cmd.exitOverride()
    // propagate exitOverride to subcommands
    for (const sub of cmd.commands) sub.exitOverride()
    return cmd
  }

  it('daemon status exits 1 when daemon is not running', async () => {
    const cmd = await getCmd(false)
    await expect(cmd.parseAsync(['node', 'xar', 'status'])).rejects.toThrow('exit:1')
    expect(exitCode).toBe(1)
  })

  it('daemon status --json outputs running:false when not running', async () => {
    const cmd = await getCmd(false)
    await expect(cmd.parseAsync(['node', 'xar', 'status', '--json'])).rejects.toThrow('exit:1')
    const parsed = JSON.parse(stdoutOutput.trim())
    expect(parsed.running).toBe(false)
  })

  it('daemon status --json contains pid when running', async () => {
    const cmd = await getCmd(true, { type: 'ok', data: { pid: 12345, uptime: 60, agents: [] } })
    await cmd.parseAsync(['node', 'xar', 'status', '--json'])
    const parsed = JSON.parse(stdoutOutput.trim())
    expect(parsed).toHaveProperty('pid')
    expect(parsed.running).toBe(true)
  })

  it('daemon stop handles daemon not running gracefully', async () => {
    const cmd = await getCmd(false)
    // stop when no pid file — should exit 1 with a message, not crash
    await expect(cmd.parseAsync(['node', 'xar', 'stop'])).rejects.toThrow('exit:1')
    expect(exitCode).toBe(1)
  })
})
