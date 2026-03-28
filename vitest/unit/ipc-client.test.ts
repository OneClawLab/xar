import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IpcClient } from '../../src/ipc/client.js'

describe('IpcClient', () => {
  let client: IpcClient

  beforeEach(() => {
    client = new IpcClient('/tmp/xar.sock', 9000)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should create client with socket path and port', () => {
    expect(client).toBeDefined()
  })

  it('should handle Windows platform detection', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })

    const winClient = new IpcClient('/tmp/xar.sock', 9000)
    expect(winClient).toBeDefined()

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
  })

  it('should have connect method', () => {
    expect(typeof client.connect).toBe('function')
  })

  it('should have send method', () => {
    expect(typeof client.send).toBe('function')
  })

  it('should have close method', () => {
    expect(typeof client.close).toBe('function')
  })
})
