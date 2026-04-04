import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('createStartCommand', () => {
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

  async function getCmd(daemonRunning: boolean, ipcResponse: { type: string; error?: string }) {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: '/tmp/theclaw', ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('../../src/daemon/pid.js', () => ({
      checkDaemonRunning: async () => daemonRunning,
    }))
    vi.doMock('../../src/ipc/client.js', () => ({
      sendIpcMessage: async () => ipcResponse,
    }))
    const { createStartCommand } = await import('../../src/commands/start.js')
    const cmd = createStartCommand()
    cmd.exitOverride()
    return cmd
  }

  it('exits 1 when daemon is not running', async () => {
    const cmd = await getCmd(false, { type: 'ok' })
    await expect(cmd.parseAsync(['node', 'xar', 'myagent'])).rejects.toThrow('exit:1')
    expect(exitCode).toBe(1)
    expect(stderrOutput).toContain('not running')
  })

  it('prints success when daemon responds ok', async () => {
    const cmd = await getCmd(true, { type: 'ok' })
    await cmd.parseAsync(['node', 'xar', 'myagent'])
    expect(stdoutOutput).toContain('myagent')
    expect(stdoutOutput).toContain('started')
  })

  it('sends agent_start IPC message with correct agent_id', async () => {
    let capturedMsg: unknown
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: '/tmp/theclaw', ipcPort: 28213, logLevel: 'info' }),
    }))
    vi.doMock('../../src/daemon/pid.js', () => ({
      checkDaemonRunning: async () => true,
    }))
    vi.doMock('../../src/ipc/client.js', () => ({
      sendIpcMessage: async (msg: unknown) => { capturedMsg = msg; return { type: 'ok' } },
    }))
    const { createStartCommand } = await import('../../src/commands/start.js')
    const cmd = createStartCommand()
    cmd.exitOverride()
    await cmd.parseAsync(['node', 'xar', 'targetagent'])
    expect(capturedMsg).toMatchObject({ type: 'agent_start', agent_id: 'targetagent' })
  })
})
