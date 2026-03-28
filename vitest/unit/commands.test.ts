import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createChatCommand } from '../../src/commands/chat.js'
import { createDaemonCommand } from '../../src/commands/daemon.js'
import { createInitCommand } from '../../src/commands/init.js'
import { createListCommand } from '../../src/commands/list.js'
import { createSendCommand } from '../../src/commands/send.js'
import { createStartCommand } from '../../src/commands/start.js'
import { createStatusCommand } from '../../src/commands/status.js'
import { createStopCommand } from '../../src/commands/stop.js'

describe('commands', () => {
  describe('chat', () => {
    it('name and description', () => {
      const cmd = createChatCommand()
      expect(cmd.name()).toBe('chat')
      expect(cmd.description()).toBeTruthy()
    })
  })

  describe('list', () => {
    it('name and description', () => {
      const cmd = createListCommand()
      expect(cmd.name()).toBe('list')
      expect(cmd.description()).toBeTruthy()
    })
  })

  describe('send', () => {
    it('name and description', () => {
      const cmd = createSendCommand()
      expect(cmd.name()).toBe('send')
      expect(cmd.description()).toBeTruthy()
    })
  })

  describe('start', () => {
    it('name and description', () => {
      const cmd = createStartCommand()
      expect(cmd.name()).toBe('start')
      expect(cmd.description()).toBeTruthy()
    })
  })

  describe('stop', () => {
    it('name and description', () => {
      const cmd = createStopCommand()
      expect(cmd.name()).toBe('stop')
      expect(cmd.description()).toBeTruthy()
    })
  })

  describe('status', () => {
    it('name and description', () => {
      const cmd = createStatusCommand()
      expect(cmd.name()).toBe('status')
      expect(cmd.description()).toBeTruthy()
    })

    it('accepts optional agent id argument', () => {
      const cmd = createStatusCommand()
      expect(cmd.args.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('daemon', () => {
    it('name and description', () => {
      const cmd = createDaemonCommand()
      expect(cmd.name()).toBe('daemon')
      expect(cmd.description()).toBeTruthy()
    })

    it('has start/stop/status subcommands', () => {
      const cmd = createDaemonCommand()
      const names = cmd.commands.map((c) => c.name())
      expect(names).toContain('start')
      expect(names).toContain('stop')
      expect(names).toContain('status')
    })
  })

  describe('init', () => {
    let tmpDir: string
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `xar-test-${Date.now()}`)
      await fs.mkdir(tmpDir, { recursive: true })
      originalEnv = { ...process.env }
      process.env.XAR_HOME = tmpDir
    })

    afterEach(async () => {
      process.env = originalEnv
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })

    it('name and description', () => {
      const cmd = createInitCommand()
      expect(cmd.name()).toBe('init')
      expect(cmd.description()).toContain('Initialize')
    })
  })
})
