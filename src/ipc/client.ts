/**
 * IPC Client - For CLI commands to communicate with daemon
 */

import { WebSocket } from 'ws'
import type { IpcMessage } from '../types.js'
import { CliError } from '../types.js'

export class IpcClient {
  private ws: WebSocket | null = null
  private tcpPort: number

  constructor(tcpPort: number) {
    this.tcpPort = tcpPort
  }

  async connect(): Promise<void> {
    await this.connectTcp()
  }

  private async connectTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.tcpPort}`
      this.ws = new WebSocket(url)

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new CliError('Failed to connect to daemon', 1))
      }, 5000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        resolve()
      })

      this.ws.on('error', () => {
        clearTimeout(timeout)
        reject(new CliError('Failed to connect to daemon', 1))
      })
    })
  }

  async send(message: IpcMessage): Promise<IpcMessage> {
    if (!this.ws) {
      throw new CliError('Not connected to daemon', 1)
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new CliError('Daemon response timeout', 1))
      }, 10000)

      const handler = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString()) as IpcMessage
          clearTimeout(timeout)
          this.ws!.off('message', handler)
          resolve(response)
        } catch (err) {
          // Ignore parse errors, wait for next message
        }
      }

      this.ws!.on('message', handler)

      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timeout)
          this.ws!.off('message', handler)
          reject(err)
        }
      })
    })
  }

  close(): void {
    if (this.ws) {
      this.ws.close()
    }
  }
}

export async function sendIpcMessage(
  message: IpcMessage,
  tcpPort: number,
): Promise<IpcMessage> {
  const client = new IpcClient(tcpPort)
  try {
    await client.connect()
    const response = await client.send(message)
    return response
  } finally {
    client.close()
  }
}
