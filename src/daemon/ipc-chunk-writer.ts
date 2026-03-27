/**
 * IPC Chunk Writer - implements Writable stream for streaming LLM tokens via IPC
 */

import { Writable } from 'stream'
import type { ReplyContext } from '../types.js'
import type { IpcConnection } from '../ipc/types.js'

export class IpcChunkWriter extends Writable {
  private sessionId: string

  constructor(
    private conn: IpcConnection,
    private replyContext: ReplyContext,
  ) {
    super()
    // Generate session ID from reply context
    this.sessionId = `${replyContext.channel_id}:${replyContext.session_id}`
  }

  _write(chunk: Buffer | string, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void): void {
    try {
      const token = typeof chunk === 'string' ? chunk : chunk.toString('utf8')

      this.conn.send({
        type: 'stream_token',
        session_id: this.sessionId,
        token,
      })

      callback()
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
