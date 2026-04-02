/**
 * Chat rendering utilities — extracted from commands/chat.ts for testability.
 */

const INDENT = '    '
const LINE_MAX = 120
const MULTILINE_MAX_LINES = 5

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `…(${s.length - maxLen} chars)`
}

function renderInlineOrBlock(prefix: string, text: string, indent: string): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0)
  if (lines.length <= 1) {
    const line = lines[0] ?? ''
    const display = line.length > LINE_MAX ? line.slice(0, LINE_MAX) + `…(${line.length - LINE_MAX} chars)` : line
    return `${prefix} ${display}\n`
  }
  const shown = lines.slice(0, MULTILINE_MAX_LINES)
  const omitted = lines.length - MULTILINE_MAX_LINES
  const body = shown.map(l => `${indent}${l.length > LINE_MAX ? l.slice(0, LINE_MAX) + `…(${l.length - LINE_MAX} chars)` : l}`)
  return `${prefix}\n${body.join('\n')}${omitted > 0 ? `\n${indent}…(${omitted} lines)` : ''}\n`
}

export function renderToolCall(data: unknown): string {
  if (typeof data !== 'object' || data === null) {
    return `  tool_call: ${JSON.stringify(data)}\n`
  }
  const d = data as Record<string, unknown>
  const name = typeof d['name'] === 'string' ? d['name'] : 'unknown'
  if (name !== 'bash_exec') {
    return `  tool_call: ${name}(${JSON.stringify(d['arguments'] ?? {})})\n`
  }
  const args = (typeof d['arguments'] === 'object' && d['arguments'] !== null)
    ? d['arguments'] as Record<string, unknown>
    : {}
  const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : ''
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : ''
  const timeout = args['timeout_seconds'] !== undefined ? String(args['timeout_seconds']) : ''

  let out = `  ▶ ${comment || 'bash_exec'}\n`
  if (command) out += renderInlineOrBlock(`${INDENT}command:`, command, `${INDENT}  `)
  const meta: string[] = []
  if (cwd) meta.push(`cwd: ${cwd}`)
  if (timeout) meta.push(`timeout: ${timeout}s`)
  if (meta.length > 0) out += `${INDENT}${meta.join('  ')}\n`
  return out
}

export function renderToolResult(data: unknown): string {
  if (typeof data !== 'object' || data === null) {
    return `  ✓ ${truncate(JSON.stringify(data), LINE_MAX)}\n`
  }
  const d = data as Record<string, unknown>
  const exitCode = d['exitCode'] !== undefined ? d['exitCode'] : d['exit_code']
  const stdout = typeof d['stdout'] === 'string' ? d['stdout'] : ''
  const stderr = typeof d['stderr'] === 'string' ? d['stderr'] : ''
  const errMsg = typeof d['error'] === 'string' ? d['error'] : ''
  const isSuccess = exitCode === 0 || exitCode === undefined
  const content = errMsg || [stdout, stderr].filter(s => s.trim()).join('\n').trim()
  const prefix = `  ${isSuccess ? '✓' : '✗'}`
  if (!content) return `${prefix} (no output)\n`
  return renderInlineOrBlock(prefix, content, INDENT)
}
