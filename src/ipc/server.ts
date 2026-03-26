/**
 * IPC Server - WebSocket over Unix socket with TCP fallback
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createNetServer, Server as NetServer } from 'net'
import { createServer as createUnixServer } from 'net'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { IpcMessage } from '../types.js'
import type { IpcServer, IpcServerConfig, IpcConnection } from './types.js'

class WebSocketConnection implements IpcConnection {
  constructor(
    readonly id: string,
    private ws: WebSocket,
  ) {}

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
  private netServer: any = null
  private connections: Map<string, IpcConnection> = new Map()
  private messageHandlers: ((message: IpcMessage, connId: string) => Promise<void>)[] = []
  private connectionHandlers: ((conn: IpcConnection, connId: string) => void)[] = []
  private agentQueues: Map<string, any> = new Map()
  private config: IpcServerConfig
  private connectionCounter = 0

  constructor(config: IpcServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    // On Windows, Unix domain sockets are unreliable — go straight to TCP
    if (process.platform === 'win32') {
      await this.startTcpServer()
      return
    }
    // Try Unix socket first, fallback to TCP
    try {
      await this.startUnixSocket()
      return
    } catch (err) {
      // Unix socket failed — clean up any partial state
      if (this.wss) { try { this.wss.close() } catch {} this.wss = null }
      if (this.netServer) { try { this.netServer.close() } catch {} this.netServer = null }
      // Fall through to TCP
    }
    await this.startTcpServer()
  }

  private async startUnixSocket(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.config.socketPath)
    await fs.mkdir(dir, { recursive: true })

    // Remove existing socket file if it exists
    try {
      await fs.unlink(this.config.socketPath)
    } catch {
      // Ignore if doesn't exist
    }

    return new Promise<void>((resolve, reject) => {
      const netServer = createUnixServer()
      const wss = new WebSocketServer({ noServer: true })

      netServer.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      })

      netServer.on('error', (err) => {
        reject(err)
      })

      netServer.listen(this.config.socketPath, () => {
        this.netServer = netServer
        this.wss = wss
        this.setupWebSocketHandlers()
        resolve()
      })
    })
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
          console.error('Error processing IPC message:', err)
        }
      })

      ws.on('close', () => {
        this.connections.delete(connId)
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

    // Close net server
    if (this.netServer) {
      await new Promise<void>((resolve) => {
        this.netServer!.close(() => {
          resolve()
        })
      })
    }

    // Clean up socket file
    try {
      await fs.unlink(this.config.socketPath)
    } catch {
      // Ignore
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
}

export function createIpcServer(config: IpcServerConfig): IpcServer {
  return new IpcServerImpl(config)
}
