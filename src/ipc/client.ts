/**
 * IPC Client - For CLI commands to communicate with daemon
 */

import { WebSocket } from 'ws'
import type { IpcMessage } from '../types.js'
import { CliError } from '../types.js'

export class IpcClient {
  private ws: WebSocket | null = null
  private socketPath: string
  private tcpPort: number

  constructor(socketPath: string, tcpPort: number) {
    this.socketPath = socketPath
    this.tcpPort = tcpPort
  }

  async connect(): Promise<void> {
    // On Windows, Unix domain sockets are unreliable — go straight to TCP
    if (process.platform === 'win32') {
      await this.connectTcp()
      return
    }
    // Try Unix socket first, fall back to TCP
    try {
      await this.connectUnix()
    } catch {
      await this.connectTcp()
    }
  }

  private async connectUnix(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws+unix://${this.socketPath}`

      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        reject(new Error('Invalid Unix socket URL'))
        return
      }

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Unix socket timeout'))
      }, 3000)

      ws.on('open', () => {
        clearTimeout(timeout)
        this.ws = ws
        resolve()
      })

      ws.on('error', () => {
        clearTimeout(timeout)
        ws.close()
        reject(new Error('Unix socket error'))
      })
    })
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
  socketPath: string,
  tcpPort: number,
): Promise<IpcMessage> {
  const client = new IpcClient(socketPath, tcpPort)
  try {
    await client.connect()
    const response = await client.send(message)
    return response
  } finally {
    client.close()
  }
}
