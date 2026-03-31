import { describe, it, expect } from 'vitest'
import { CliError } from '../../src/types.js'

describe('CliError', () => {
  it('should create with message and default exit code 1', () => {
    const err = new CliError('something failed')
    expect(err.message).toBe('something failed')
    expect(err.exitCode).toBe(1)
    expect(err.name).toBe('CliError')
    expect(err).toBeInstanceOf(Error)
  })

  it('should create with explicit exit code', () => {
    const err = new CliError('bad args', 2)
    expect(err.exitCode).toBe(2)
  })

  it('should preserve stack trace', () => {
    const err = new CliError('test')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('CliError')
  })
})
