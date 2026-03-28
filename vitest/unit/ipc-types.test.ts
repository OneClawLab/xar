import { describe, it, expect } from 'vitest'
import type { IpcMessage } from '../../src/types.js'

describe('IPC Types', () => {
  it('inbound_message carries agent_id and message content', () => {
    const msg: IpcMessage = {
      type: 'inbound_message',
      agent_id: 'agent1',
      message: {
        source: 'peer:user1',
        content: 'hello',
        reply_context: {
          channel_type: 'dm',
          channel_id: 'ch1',
          session_type: 'dm',
          session_id: 'sess1',
          peer_id: 'user1',
        },
      },
    }
    expect(msg.type).toBe('inbound_message')
    expect(msg.agent_id).toBe('agent1')
    expect(msg.message?.content).toBe('hello')
  })

  it('stream_token carries session_id and token', () => {
    const msg: IpcMessage = { type: 'stream_token', session_id: 'sess1', token: 'hello' }
    expect(msg.token).toBe('hello')
    expect(msg.session_id).toBe('sess1')
  })

  it('stream_error carries error string', () => {
    const msg: IpcMessage = { type: 'stream_error', error: 'Connection lost' }
    expect(msg.error).toBe('Connection lost')
  })

  it('agent_start and agent_stop carry agent_id', () => {
    const start: IpcMessage = { type: 'agent_start', agent_id: 'a1' }
    const stop: IpcMessage = { type: 'agent_stop', agent_id: 'a1' }
    expect(start.agent_id).toBe('a1')
    expect(stop.agent_id).toBe('a1')
  })

  it('ok and error are minimal messages', () => {
    const ok: IpcMessage = { type: 'ok' }
    const err: IpcMessage = { type: 'error', error: 'oops' }
    expect(ok.type).toBe('ok')
    expect(err.error).toBe('oops')
  })
})
