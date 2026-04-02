import { describe, it, expect } from 'vitest'
import { renderToolCall, renderToolResult } from '../../src/chat-render.js'

describe('renderToolCall', () => {
  it('formats bash_exec with comment, command, and cwd', () => {
    const data = {
      name: 'bash_exec',
      arguments: { comment: 'list files', command: 'ls -la', cwd: '/tmp' },
    }
    const out = renderToolCall(data)
    expect(out).toContain('list files')
    expect(out).toContain('ls -la')
    expect(out).toContain('cwd: /tmp')
  })

  it('formats bash_exec with timeout', () => {
    const data = {
      name: 'bash_exec',
      arguments: { command: 'sleep 10', timeout_seconds: 30 },
    }
    const out = renderToolCall(data)
    expect(out).toContain('timeout: 30s')
  })

  it('formats non-bash_exec tool as tool_call: name(args)', () => {
    const data = { name: 'read_file', arguments: { path: '/etc/hosts' } }
    const out = renderToolCall(data)
    expect(out).toContain('tool_call: read_file')
    expect(out).toContain('/etc/hosts')
  })

  it('handles non-object data gracefully', () => {
    const out = renderToolCall('raw string')
    expect(out).toContain('tool_call:')
  })
})

describe('renderToolResult', () => {
  it('shows ✓ when exitCode is 0', () => {
    const data = { exitCode: 0, stdout: 'ok', stderr: '' }
    const out = renderToolResult(data)
    expect(out).toContain('✓')
  })

  it('shows ✗ when exitCode is non-zero', () => {
    const data = { exitCode: 1, stdout: '', stderr: 'error occurred' }
    const out = renderToolResult(data)
    expect(out).toContain('✗')
  })

  it('shows (no output) when stdout and stderr are empty', () => {
    const data = { exitCode: 0, stdout: '', stderr: '' }
    const out = renderToolResult(data)
    expect(out).toContain('(no output)')
  })

  it('shows ✓ when exitCode is undefined', () => {
    const data = { stdout: 'some output', stderr: '' }
    const out = renderToolResult(data)
    expect(out).toContain('✓')
  })

  it('shows error message when error field is present', () => {
    const data = { error: 'timeout exceeded', exitCode: 1 }
    const out = renderToolResult(data)
    expect(out).toContain('timeout exceeded')
  })
})
