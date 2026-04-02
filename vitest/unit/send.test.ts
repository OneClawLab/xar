import { describe, it, expect, afterEach } from 'vitest'
import { buildInternalSource } from '../../src/commands/send.js'
import { CliError } from '../../src/types.js'

describe('buildInternalSource()', () => {
  afterEach(() => {
    delete process.env['XAR_AGENT_ID']
    delete process.env['XAR_CONV_ID']
  })

  it('constructs internal source from env vars when set', () => {
    // Requirements: 5.1
    process.env['XAR_AGENT_ID'] = 'evolver'
    process.env['XAR_CONV_ID'] = 'conv-abc'
    expect(buildInternalSource({})).toBe('internal:agent:conv-abc:evolver')
  })

  it('passes through explicit --source, ignoring env vars', () => {
    // Requirements: 5.2
    process.env['XAR_AGENT_ID'] = 'evolver'
    process.env['XAR_CONV_ID'] = 'conv-abc'
    const explicit = 'external:cli:default:dm:cli:cli'
    expect(buildInternalSource({ source: explicit })).toBe(explicit)
  })

  it('throws CliError with exitCode 2 when env vars are missing', () => {
    // Requirements: 5.3
    expect(() => buildInternalSource({})).toThrow(CliError)
    try {
      buildInternalSource({})
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).exitCode).toBe(2)
    }
  })

  it('throws CliError when only XAR_AGENT_ID is set', () => {
    process.env['XAR_AGENT_ID'] = 'evolver'
    expect(() => buildInternalSource({})).toThrow(CliError)
  })

  it('throws CliError when only XAR_CONV_ID is set', () => {
    process.env['XAR_CONV_ID'] = 'conv-abc'
    expect(() => buildInternalSource({})).toThrow(CliError)
  })
})
