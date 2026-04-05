import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { getThreadLib, openOrCreateThread, threadExists } from '../../src/agent/thread-lib.js'

vi.mock('../../src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: '/tmp/theclaw-test', ipcPort: 28213, logLevel: 'info' })),
}))

vi.mock('thread', () => ({
  ThreadLib: vi.fn().mockImplementation(() => ({
    open: vi.fn(async (p: string) => ({ path: p })),
    init: vi.fn(async (p: string) => ({ path: p })),
    exists: vi.fn(async () => false),
  })),
  ThreadStore: vi.fn(),
}))

describe('thread-lib', () => {
  describe('getThreadLib', () => {
    it('returns a singleton instance', () => {
      const lib1 = getThreadLib()
      const lib2 = getThreadLib()
      expect(lib1).toBe(lib2)
    })
  })

  describe('openOrCreateThread', () => {
    it('opens thread at correct path', async () => {
      const store = await openOrCreateThread('agent1', 'peers/alice') as unknown as { path: string }
      expect(store.path).toBe(join('/tmp/theclaw-test', 'agents', 'agent1', 'threads', 'peers', 'alice'))
    })

    it('different threadIds produce different paths', async () => {
      const s1 = await openOrCreateThread('agent1', 'peers/alice') as unknown as { path: string }
      const s2 = await openOrCreateThread('agent1', 'peers/bob') as unknown as { path: string }
      expect(s1.path).not.toBe(s2.path)
    })
  })

  describe('threadExists', () => {
    it('returns false when thread does not exist', async () => {
      const exists = await threadExists('agent1', 'peers/alice')
      expect(exists).toBe(false)
    })
  })
})
