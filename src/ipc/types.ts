/**
 * IPC Server types and interfaces
 */

import type { IpcMessage } from '../types.js'

export interface IpcConnection {
  id: string
  send(message: IpcMessage): Promise<void>
  close(): void
}

export interface IpcServerConfig {
  tcpPort: number
}

export interface IpcServer {
  start(): Promise<void>
  stop(): Promise<void>
  broadcast(message: IpcMessage): Promise<void>
  sendToConnection(connId: string, message: IpcMessage): Promise<void>
  registerQueue(agentId: string, queue: any): void
  onMessage(handler: (message: IpcMessage, connId: string) => Promise<void>): void
  onConnection(handler: (conn: IpcConnection, connId: string) => void): void
  onDisconnect(handler: (connId: string) => void): void
}

