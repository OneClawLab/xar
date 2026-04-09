import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('createListCommand', () => {
  let tmpHome: string
  let stdoutOutput: string

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `xar-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(join(tmpHome, 'agents'), { recursive: true })
    stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { stdoutOutput += s; return true })
    vi.spyOn(console, 'log').mockImplementation((s) => { stdoutOutput += String(s) + '\n' })
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function getCmd() {
    vi.doMock('../../src/config.js', () => ({
      getDaemonConfig: () => ({ theClawHome: tmpHome, ipcPort: 29211, logLevel: 'info' }),
    }))
    const { createListCommand } = await import('../../src/commands/list.js')
    const cmd = createListCommand()
    cmd.exitOverride()
    return cmd
  }

  async function createAgent(id: string, kind = 'user') {
    const agentDir = join(tmpHome, 'agents', id)
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(join(agentDir, 'config.json'), JSON.stringify({ agent_id: id, kind }))
  }

  it('outputs empty list when agents directory does not exist', async () => {
    await fs.rm(join(tmpHome, 'agents'), { recursive: true, force: true })
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar'])
    expect(stdoutOutput).toContain('No agents found')
  })

  it('lists all agents with id and kind', async () => {
    await createAgent('admin', 'system')
    await createAgent('worker', 'user')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar'])
    expect(stdoutOutput).toContain('admin')
    expect(stdoutOutput).toContain('worker')
  })

  it('--json outputs valid JSON array', async () => {
    await createAgent('alpha', 'user')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar', '--json'])
    const jsonLine = stdoutOutput.trim()
    const parsed = JSON.parse(jsonLine)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toHaveProperty('id', 'alpha')
    expect(parsed[0]).toHaveProperty('kind', 'user')
  })

  it('--json outputs empty array when no agents', async () => {
    await fs.rm(join(tmpHome, 'agents'), { recursive: true, force: true })
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar', '--json'])
    const parsed = JSON.parse(stdoutOutput.trim())
    expect(parsed).toEqual([])
  })

  it('skips agents with invalid config.json', async () => {
    await createAgent('good', 'user')
    const badDir = join(tmpHome, 'agents', 'bad')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(join(badDir, 'config.json'), 'not-json{{{')
    const cmd = await getCmd()
    await cmd.parseAsync(['node', 'xar', '--json'])
    const parsed = JSON.parse(stdoutOutput.trim())
    const ids = parsed.map((a: { id: string }) => a.id)
    expect(ids).toContain('good')
    expect(ids).not.toContain('bad')
  })
})
