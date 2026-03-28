import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { getThreadLib, getAgentInboxPath, getThreadPath } from '../../src/agent/thread-lib.js'

vi.mock('../../src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: '/tmp/theclaw-test', daemonPort: 18792, logLevel: 'info' })),
}))

// Mock the 'thread' package — we only test the wrapper logic here
vi.mock('thread', () => ({
  ThreadLib: vi.fn().mockImplementation(() => ({
    open: vi.fn(async (p: string) => ({ path: p })),
    init: vi.fn(async (p: string) => ({ path: p })),
    exists: vi.fn(async () => false),
    destroy: vi.fn(async () => {}),
  })),
  ThreadStore: vi.fn(),
}))

describe('thread-lib', () => {
  describe('getAgentInboxPath', () => {
    it('returns correct inbox path under theClawHome', async () => {
      const path = await getAgentInboxPath('agent1')
      expect(path).toBe(join('/tmp/theclaw-test', 'agents', 'agent1', 'inbox'))
    })
  })

  describe('getThreadPath', () => {
    it('returns correct thread path', async () => {
      const path = await getThreadPath('agent1', 'main')
      expect(path).toBe(join('/tmp/theclaw-test', 'agents', 'agent1', 'threads', 'main'))
    })

    it('uses threadId in path', async () => {
      const path1 = await getThreadPath('agent1', 'peer-user1')
      const path2 = await getThreadPath('agent1', 'peer-user2')
      expect(path1).not.toBe(path2)
      expect(path1).toContain('peer-user1')
      expect(path2).toContain('peer-user2')
    })
  })

  describe('getThreadLib', () => {
    it('returns a singleton instance', () => {
      const lib1 = getThreadLib()
      const lib2 = getThreadLib()
      expect(lib1).toBe(lib2)
    })
  })
})
