/**
 * Daemon management commands: start, stop, status
 */

import { Command } from 'commander'
import { spawn } from 'child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { readPidFile, checkDaemonRunning, ensureDaemonNotRunning, deletePidFile } from '../daemon/pid.js'
import { getDaemonConfig } from '../config.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'

/** Poll for PID file to appear and contain a live PID, up to `timeoutMs`. */
async function waitForReady(theClawHome: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const isRunning = await checkDaemonRunning(theClawHome)
    if (isRunning) {
      return await readPidFile(theClawHome)
    }
  }
  return null
}

/**
 * Filter execArgv to pass through loader flags (tsx, esm) but drop
 * debug/inspect flags that would cause port conflicts in the child.
 */
function safeExecArgv(): string[] {
  return process.execArgv.filter(arg =>
    !arg.startsWith('--inspect') &&
    !arg.startsWith('--debug')
  )
}

export function createDaemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage xar daemon')

  cmd
    .command('start')
    .description('Start xar daemon')
    .option('--foreground', 'Run in foreground (logs to stdout)')
    .action(async (opts) => {
      try {
        const config = getDaemonConfig()
        try {
          await ensureDaemonNotRunning(config.theClawHome)
        } catch (err: any) {
          // If daemon is already running, treat start as idempotent and succeed
          if (err instanceof CliError && /already running/i.test(err.message)) {
            console.log(err.message)
            return
          }
          throw err
        }

        if (opts.foreground) {
          // Foreground mode: run daemon directly in this process
          const { startDaemon } = await import('../daemon/index.js')
          await startDaemon(true)
        } else {
          // Background mode: spawn detached child using process.execPath + process.argv[1]
          // This avoids the Windows .cmd shim issue with spawn('xar', ...)
          const logsDir = join(config.theClawHome, 'logs')
          await fs.mkdir(logsDir, { recursive: true })
          const logFile = join(logsDir, 'xar.log')
          const logFd = openSync(logFile, 'a')
          const script = process.argv[1] ?? ''
          const child = spawn(process.execPath, [...safeExecArgv(), script, 'daemon', 'start', '--foreground'], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env },
          })
          child.unref()

          // Wait up to 5s for daemon to write its PID file
          const pid = await waitForReady(config.theClawHome, 5000)
          if (pid === null) {
            throw new CliError('Daemon failed to start within 5 seconds. Check logs: ' + logFile, 1)
          }
          console.log(`Daemon started (PID: ${pid})`)
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to start daemon:', err)
        process.exit(1)
      }
    })

  cmd
    .command('stop')
    .description('Stop xar daemon')
    .action(async () => {
      try {
        const config = getDaemonConfig()
        const pid = await readPidFile(config.theClawHome)

        if (!pid) {
          throw new CliError('Daemon is not running', 1)
        }

        try {
          process.kill(pid, 'SIGTERM')
        } catch (err: any) {
          // If the process does not exist anymore, remove stale PID file and treat as stopped
          if (err && (err.code === 'ESRCH' || err.errno === -3)) {
            console.log('Daemon is not running (stale PID file removed)')
            await deletePidFile(config.theClawHome)
            return
          }
          // Permission errors should surface as a clear message
          if (err && err.code === 'EPERM') {
            throw new CliError(`Insufficient permission to stop daemon (PID: ${pid})`, 1)
          }
          throw err
        }

        // Wait up to 30s for graceful shutdown
        for (let i = 0; i < 30; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const isRunning = await checkDaemonRunning(config.theClawHome)
          if (!isRunning) {
            console.log('Daemon stopped')
            return
          }
        }

        // Force kill (may throw ESRCH if already exited)
        try {
          process.kill(pid, 'SIGKILL')
          console.log('Daemon force killed')
        } catch (err: any) {
          if (err && (err.code === 'ESRCH' || err.errno === -3)) {
            console.log('Daemon is not running (stale PID file removed)')
            await deletePidFile(config.theClawHome)
            return
          }
          throw err
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to stop daemon:', err)
        process.exit(1)
      }
    })

  cmd
    .command('status')
    .description('Check daemon status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const config = getDaemonConfig()
        const isRunning = await checkDaemonRunning(config.theClawHome)

        if (!isRunning) {
          if (options.json) {
            console.log(JSON.stringify({ running: false }))
          } else {
            console.log('Daemon is not running')
          }
          process.exit(1)
        }

        try {
          const response = await sendIpcMessage({ type: 'daemon_status' }, config.ipcPort)
          const data = response.data as { pid: number; uptime: number; agents: Array<{ id: string }> }
          if (options.json) {
            console.log(JSON.stringify({ running: true, ...data }))
          } else {
            console.log(`Daemon is running (PID: ${data.pid})`)
            console.log(`Uptime: ${Math.floor(data.uptime)}s`)
            const agentIds = data.agents.map((a) => a.id)
            console.log(`Agents: ${agentIds.length > 0 ? agentIds.join(', ') : 'none'}`)
          }
        } catch {
          // IPC unavailable — fall back to PID info only
          const pid = await readPidFile(config.theClawHome)
          if (options.json) {
            console.log(JSON.stringify({ running: true, pid }))
          } else {
            console.log(`Daemon is running (PID: ${pid})`)
          }
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to check daemon status:', err)
        process.exit(1)
      }
    })

  return cmd
}
