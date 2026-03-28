import { describe, it, expect } from 'vitest'
import { CliError } from '../../src/types.js'

describe('Error Handling', () => {
  it('should create CliError with message and exit code', () => {
    const err = new CliError('Test error', 1)
    expect(err.message).toBe('Test error')
    expect(err.exitCode).toBe(1)
  })

  it('should create CliError with default exit code', () => {
    const err = new CliError('Test error')
    expect(err.exitCode).toBe(1)
  })

  it('should create CliError with exit code 2 for usage errors', () => {
    const err = new CliError('Invalid argument', 2)
    expect(err.exitCode).toBe(2)
  })

  it('should have correct error name', () => {
    const err = new CliError('Test', 1)
    expect(err.name).toBe('CliError')
  })

  it('should be instanceof Error', () => {
    const err = new CliError('Test', 1)
    expect(err instanceof Error).toBe(true)
  })

  it('should support error message with special characters', () => {
    const err = new CliError('Error: "quoted" message', 1)
    expect(err.message).toContain('quoted')
  })

  it('should support different exit codes', () => {
    const err0 = new CliError('Success', 0)
    const err1 = new CliError('Runtime error', 1)
    const err2 = new CliError('Usage error', 2)

    expect(err0.exitCode).toBe(0)
    expect(err1.exitCode).toBe(1)
    expect(err2.exitCode).toBe(2)
  })

  it('should preserve stack trace', () => {
    const err = new CliError('Test error', 1)
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('CliError')
  })
})
