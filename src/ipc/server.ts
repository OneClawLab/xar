/**
 * IPC Server - WebSocket over TCP
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IpcMessage } from '../types.js'
import type { IpcServer, IpcServerConfig, IpcConnection } from './types.js'

class WebSocketConnection implements IpcConnection {
  constructor(
    readonly id: string,
    private ws: WebSocket,
  ) {}

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  async send(message: IpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

export class IpcServerImpl implements IpcServer {
  private wss: WebSocketServer | null = null
  private connections: Map<string, IpcConnection> = new Map()
  private messageHandlers: ((message: IpcMessage, connId: string) => Promise<void>)[] = []
  private connectionHandlers: ((conn: IpcConnection, connId: string) => void)[] = []
  private disconnectHandlers: ((connId: string) => void)[] = []
  private agentQueues: Map<string, any> = new Map()
  private config: IpcServerConfig
  private connectionCounter = 0

  constructor(config: IpcServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    await this.startTcpServer()
  }

  private async startTcpServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.config.tcpPort, host: '127.0.0.1' })

      wss.on('listening', () => {
        this.wss = wss
        this.setupWebSocketHandlers()
        resolve()
      })

      wss.on('error', (err) => {
        reject(err)
      })
    })
  }

  private setupWebSocketHandlers(): void {
    this.wss!.on('connection', (ws: WebSocket) => {
      const connId = `conn-${++this.connectionCounter}`
      const connection = new WebSocketConnection(connId, ws)
      this.connections.set(connId, connection)

      // Call connection handlers
      for (const handler of this.connectionHandlers) {
        handler(connection, connId)
      }

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as IpcMessage

          // Call message handlers
          for (const handler of this.messageHandlers) {
            await handler(message, connId)
          }
        } catch (err) {
          // Fire disconnect handlers so daemon can clean up
          for (const handler of this.disconnectHandlers) {
            handler(connId)
          }
          process.stderr.write(`[IpcServer] error processing message on ${connId}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      })

      ws.on('close', () => {
        this.connections.delete(connId)
        for (const handler of this.disconnectHandlers) {
          handler(connId)
        }
      })

      ws.on('error', (err) => {
        console.error('WebSocket error:', err)
      })
    })
  }

  async stop(): Promise<void> {
    // Close all connections
    for (const conn of this.connections.values()) {
      conn.close()
    }
    this.connections.clear()

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          resolve()
        })
      })
    }
  }

  async broadcast(message: IpcMessage): Promise<void> {
    const promises: Promise<void>[] = []

    for (const conn of this.connections.values()) {
      promises.push(conn.send(message))
    }

    await Promise.all(promises)
  }

  async sendToConnection(connId: string, message: IpcMessage): Promise<void> {
    const conn = this.connections.get(connId)
    if (conn) {
      await conn.send(message)
    }
  }

  registerQueue(agentId: string, queue: any): void {
    this.agentQueues.set(agentId, queue)
  }

  onMessage(handler: (message: IpcMessage, connId: string) => Promise<void>): void {
    this.messageHandlers.push(handler)
  }

  onConnection(handler: (conn: IpcConnection, connId: string) => void): void {
    this.connectionHandlers.push(handler)
  }

  onDisconnect(handler: (connId: string) => void): void {
    this.disconnectHandlers.push(handler)
  }
}

export function createIpcServer(config: IpcServerConfig): IpcServer {
  return new IpcServerImpl(config)
}
