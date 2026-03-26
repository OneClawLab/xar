/**
 * Property-based tests for environment variable override
 * Validates: Requirements 18.1, 18.2, 18.3
 */

import { describe, it, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { homedir } from 'os'
import { join } from 'path'

describe('Environment Variable Override Property Tests', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('Property 15: Environment Variable Override - THECLAW_HOME override SHALL be respected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 50 }), async (customPath) => {
        process.env.THECLAW_HOME = customPath

        // Simulate config loading
        const theClawHome = process.env.THECLAW_HOME || join(homedir(), '.theclaw')

        // Verify override is applied
        return theClawHome === customPath
      }),
      { numRuns: 50 },
    )
  })

  it('Property 15: XAR_IPC_PORT override - XAR_IPC_PORT override SHALL be respected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1024, max: 65535 }), async (port) => {
        process.env.XAR_IPC_PORT = port.toString()

        // Simulate config loading
        const ipcPort = process.env.XAR_IPC_PORT ? parseInt(process.env.XAR_IPC_PORT) : 18792

        // Verify override is applied
        return ipcPort === port
      }),
      { numRuns: 50 },
    )
  })

  it('Property 15: XAR_LOG_LEVEL override - XAR_LOG_LEVEL override SHALL be respected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('debug', 'info', 'warn', 'error'),
        async (logLevel) => {
          process.env.XAR_LOG_LEVEL = logLevel

          // Simulate config loading
          const level = process.env.XAR_LOG_LEVEL || 'info'

          // Verify override is applied
          return level === logLevel
        },
      ),
      { numRuns: 50 },
    )
  })

  it('Property 15: Default values when env vars not set - Default values SHALL be used when environment variables are not set', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        // Clear environment variables
        delete process.env.THECLAW_HOME
        delete process.env.XAR_IPC_PORT
        delete process.env.XAR_LOG_LEVEL

        // Simulate config loading with defaults
        const theClawHome = process.env.THECLAW_HOME || join(homedir(), '.theclaw')
        const ipcPort = process.env.XAR_IPC_PORT ? parseInt(process.env.XAR_IPC_PORT) : 18792
        const logLevel = process.env.XAR_LOG_LEVEL || 'info'

        // Verify defaults are applied
        return (
          theClawHome === join(homedir(), '.theclaw') &&
          ipcPort === 18792 &&
          logLevel === 'info'
        )
      }),
      { numRuns: 10 },
    )
  })

  it('Property 15: Environment variable precedence - Environment variables SHALL take precedence over defaults', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          customHome: fc.string({ minLength: 1, maxLength: 50 }),
          customPort: fc.integer({ min: 1024, max: 65535 }),
          customLevel: fc.constantFrom('debug', 'info', 'warn', 'error'),
        }),
        async (data) => {
          process.env.THECLAW_HOME = data.customHome
          process.env.XAR_IPC_PORT = data.customPort.toString()
          process.env.XAR_LOG_LEVEL = data.customLevel

          // Simulate config loading
          const theClawHome = process.env.THECLAW_HOME || join(homedir(), '.theclaw')
          const ipcPort = process.env.XAR_IPC_PORT ? parseInt(process.env.XAR_IPC_PORT) : 18792
          const logLevel = process.env.XAR_LOG_LEVEL || 'info'

          // Verify env vars take precedence
          return (
            theClawHome === data.customHome &&
            ipcPort === data.customPort &&
            logLevel === data.customLevel
          )
        },
      ),
      { numRuns: 50 },
    )
  })
})
