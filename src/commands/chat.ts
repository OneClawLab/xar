/**
 * xar chat <id> - Interactive REPL for direct agent conversation
 *
 * Bypasses daemon/IPC — talks to the agent directly via pai lib and thread lib.
 * Useful for local debugging and development.
 *
 * Uses the shared `processTurn()` core so compact, ctx_usage, retry, and chat
 * logic stay in sync with the daemon run-loop.
 */

import { createInterface } from 'readline'
import { join } from 'path'
import { promises as fs } from 'fs'
import { Writable } from 'node:stream'
import { Command } from 'commander'
import { loadConfig, resolveProvider } from 'pai'
import type { ChatConfig } from 'pai'
import { getDaemonConfig } from '../config.js'
import { loadAgentConfig } from '../agent/config.js'
import { loadIdentity } from '../agent/context.js'
import { openOrCreateThread } from '../agent/thread-lib.js'
import { processTurn, estimateChatInputTokens, computeInputBudget } from '../agent/turn.js'
import type { TurnCallbacks } from '../agent/turn.js'
import { CliError } from '../types.js'

const CLI_THREAD_ID = 'peer-cli'
const CLI_SOURCE = 'peer:cli'

// ─── Progress rendering ───────────────────────────────────────────────────────

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

function renderToolCall(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  tool_call: ${JSON.stringify(data)}\n`)
    return
  }
  const d = data as Record<string, unknown>
  const name = typeof d['name'] === 'string' ? d['name'] : 'unknown'
  if (name !== 'bash_exec') {
    process.stderr.write(`  tool_call: ${name}(${JSON.stringify(d['arguments'] ?? {})})\n`)
    return
  }
  const args = (typeof d['arguments'] === 'object' && d['arguments'] !== null)
    ? d['arguments'] as Record<string, unknown>
    : {}
  const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : ''
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : ''
  const timeout = args['timeout_seconds'] !== undefined ? String(args['timeout_seconds']) : ''

  process.stderr.write(`  ▶ ${comment || 'bash_exec'}\n`)
  if (command) process.stderr.write(renderInlineOrBlock(`${INDENT}command:`, command, `${INDENT}  `))
  const meta: string[] = []
  if (cwd) meta.push(`cwd: ${cwd}`)
  if (timeout) meta.push(`timeout: ${timeout}s`)
  if (meta.length > 0) process.stderr.write(`${INDENT}${meta.join('  ')}\n`)
}

function renderToolResult(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  ✓ ${truncate(JSON.stringify(data), LINE_MAX)}\n`)
    return
  }
  const d = data as Record<string, unknown>
  const exitCode = d['exitCode'] !== undefined ? d['exitCode'] : d['exit_code']
  const stdout = typeof d['stdout'] === 'string' ? d['stdout'] : ''
  const stderr = typeof d['stderr'] === 'string' ? d['stderr'] : ''
  const errMsg = typeof d['error'] === 'string' ? d['error'] : ''
  const isSuccess = exitCode === 0 || exitCode === undefined
  const content = errMsg || [stdout, stderr].filter(s => s.trim()).join('\n').trim()
  const prefix = `  ${isSuccess ? '✓' : '✗'}`
  if (!content) { process.stderr.write(`${prefix} (no output)\n`); return }
  process.stderr.write(renderInlineOrBlock(prefix, content, INDENT))
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function createChatCommand(): Command {
  return new Command('chat')
    .description('Interactive chat with an agent (bypasses daemon, for local debugging)')
    .argument('<id>', 'Agent ID')
    .action(async (id: string) => {
      try {
        const daemonConfig = getDaemonConfig()
        const agentDir = join(daemonConfig.theClawHome, 'agents', id)

        // Verify agent exists
        try {
          await fs.access(agentDir)
        } catch {
          throw new CliError(`Agent '${id}' not found at ${agentDir} — run 'xar init ${id}' first`, 1)
        }

        const agentConfig = await loadAgentConfig(id, daemonConfig.theClawHome)
        const paiConfig = await loadConfig()
        const { provider } = await resolveProvider(paiConfig, agentConfig.pai.provider)

        const chatConfig: ChatConfig = {
          provider: agentConfig.pai.provider,
          model: agentConfig.pai.model,
          apiKey: provider.apiKey ?? '',
          stream: true,
          ...(provider.api !== undefined ? { api: provider.api } : {}),
          ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.reasoning !== undefined ? { reasoning: provider.reasoning } : {}),
          ...(provider.contextWindow !== undefined ? { contextWindow: provider.contextWindow } : {}),
          ...(provider.providerOptions !== undefined ? { providerOptions: provider.providerOptions } : {}),
        }

        const sessionFile = join(agentDir, 'sessions', `${CLI_THREAD_ID}.jsonl`)
        await fs.mkdir(join(agentDir, 'sessions'), { recursive: true })

        const threadStore = await openOrCreateThread(id, CLI_THREAD_ID)

        process.stdout.write(`Chatting with agent '${id}' (Ctrl+C or Ctrl+D to exit)\n\n`)

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: process.stdin.isTTY,
          prompt: 'Q: ',
        })

        let processing = false

        const handleLine = async (line: string): Promise<void> => {
          const text = line.trim()
          if (!text || processing) return
          processing = true

          try {
            // Push user message to thread
            await threadStore.push({ source: CLI_SOURCE, type: 'message', content: text })

            // Build system prompt (identity + all memory layers)
            const identity = await loadIdentity(id)
            const memoryDir = join(agentDir, 'memory')
            const memParts: string[] = [identity]
            for (const [file, label] of [
              ['agent.md', 'Agent Memory'],
              [`user-cli.md`, 'Peer Memory'],
              [`thread-${CLI_THREAD_ID}.md`, 'Thread Memory'],
            ] as [string, string][]) {
              try {
                const content = await fs.readFile(join(memoryDir, file), 'utf-8')
                if (content.trim()) memParts.push(`## ${label}\n${content}`)
              } catch { /* missing is fine */ }
            }
            const systemPrompt = memParts.join('\n\n')

            // Build history from thread events
            const events = await threadStore.peek({ lastEventId: 0, limit: 1000 })
            const historyEvents = events.slice(0, -1)
            type HistoryMessage = { role: 'user' | 'assistant' | 'tool'; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }
            const history: HistoryMessage[] = []
            for (const ev of historyEvents) {
              if (ev.type === 'message' && ev.source !== 'self') {
                history.push({ role: 'user', content: ev.content })
              } else if (ev.type === 'record') {
                try {
                  const msg = JSON.parse(ev.content) as HistoryMessage
                  if (msg.role === 'assistant' || msg.role === 'tool') {
                    history.push(msg)
                  }
                } catch {
                  if (ev.source === 'self') {
                    history.push({ role: 'assistant', content: ev.content })
                  }
                }
              }
            }

            const chatInput = { system: systemPrompt, history, userMessage: text }

            // Streaming token writer → stdout
            let replyHeaderPrinted = false
            let replyText = ''
            const stdoutWriter = new Writable({
              write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
                const token = chunk.toString('utf8')
                if (!replyHeaderPrinted) {
                  process.stdout.write(`\nA:\n`)
                  replyHeaderPrinted = true
                }
                process.stdout.write(token)
                replyText += token
                callback()
              },
            })

            process.stderr.write(`\n--- working...\n`)

            const toK = (n: number): string => `${Math.round(n / 1000)}K`

            const callbacks: TurnCallbacks = {
              onCompactStart(reason) { process.stderr.write(`compacting session (${reason})...\n`) },
              onCompactEnd(before, after) { process.stderr.write(`compact done (${toK(before)} → ${toK(after)})\n`) },
              onCtxUsage(total, budget, pct) { process.stderr.write(`\nctx: ${pct}% (${toK(total)}/${toK(budget)})\n`) },
              onStreamStart() { /* noop — CLI prints "working..." above */ },
              onStreamEnd() {
                if (replyHeaderPrinted) { process.stdout.write('\n\n') }
                else { process.stdout.write(`\nA:\n${replyText}\n\n`) }
              },
              onStreamError(error) { process.stderr.write(`\nError: ${error}\n\n`) },
              onThinkingDelta() { /* ignore in CLI */ },
              onToolCall(tc) { renderToolCall(tc) },
              onToolResult(tr) { renderToolResult(tr) },
            }

            const result = await processTurn({
              chatInput,
              chatConfig,
              tokenWriter: stdoutWriter,
              sessionFile,
              agentDir,
              threadId: CLI_THREAD_ID,
              contextWindow: provider.contextWindow,
              maxOutputTokens: provider.maxTokens,
              maxAttempts: agentConfig.retry.max_attempts,
              logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: async () => {} },
              callbacks,
            })

            // Write assistant/tool records to thread
            for (const m of result.newMessages) {
              const source = m.role === 'assistant' ? 'self' : `tool:${(m as any).name ?? ''}`
              const subtype = m.role === 'tool' ? 'toolcall' : undefined
              await threadStore.push({
                source,
                type: 'record',
                ...(subtype ? { subtype } : {}),
                content: JSON.stringify(m),
              })
            }
          } catch (err) {
            process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n\n`)
          }

          processing = false
          rl.prompt()
        }

        rl.on('line', (line) => { void handleLine(line) })
        rl.on('close', () => { process.stdout.write('\n'); process.exit(0) })
        rl.prompt()

      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('chat error:', err)
        process.exit(1)
      }
    })
}
