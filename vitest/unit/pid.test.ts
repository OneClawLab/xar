import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writePidFile, readPidFile, deletePidFile, checkDaemonRunning } from '../../src/daemon/pid.js'

describe('pid file utilities', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `xar-pid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpHome, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  describe('readPidFile', () => {
    it('returns null when pid file does not exist', async () => {
      const result = await readPidFile(tmpHome)
      expect(result).toBeNull()
    })

    it('returns the pid when file exists', async () => {
      await writePidFile(tmpHome, 99999)
      const result = await readPidFile(tmpHome)
      expect(result).toBe(99999)
    })
  })

  describe('writePidFile / deletePidFile', () => {
    it('writes and then deletes pid file', async () => {
      await writePidFile(tmpHome, 12345)
      expect(await readPidFile(tmpHome)).toBe(12345)
      await deletePidFile(tmpHome)
      expect(await readPidFile(tmpHome)).toBeNull()
    })

    it('deletePidFile does not throw when file does not exist', async () => {
      await expect(deletePidFile(tmpHome)).resolves.not.toThrow()
    })
  })

  describe('checkDaemonRunning', () => {
    it('returns false when pid file does not exist', async () => {
      expect(await checkDaemonRunning(tmpHome)).toBe(false)
    })

    it('returns false when pid file contains a non-existent process', async () => {
      // PID 999999999 is virtually guaranteed not to exist
      await writePidFile(tmpHome, 999999999)
      expect(await checkDaemonRunning(tmpHome)).toBe(false)
    })

    it('returns true when pid file contains the current process pid', async () => {
      await writePidFile(tmpHome, process.pid)
      expect(await checkDaemonRunning(tmpHome)).toBe(true)
    })
  })
})
