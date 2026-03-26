/**
 * Agent start command
 */

import { Command } from 'commander'
import { getDaemonConfig, getSocketPath } from '../config.js'
import { checkDaemonRunning, readPidFile } from '../daemon/pid.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'

export function createStartCommand(): Command {
  return new Command('start')
    .description('Start an agent')
    .argument('<id>', 'Agent ID')
    .action(async (id: string) => {
      try {
        const config = getDaemonConfig()

        // Check if daemon is running
        const isRunning = await checkDaemonRunning(config.theClawHome)
        if (!isRunning) {
          throw new CliError('Daemon is not running. Run "xar daemon start" first', 1)
        }

        // Send agent_start message via IPC
        const response = await sendIpcMessage(
          { type: 'agent_start', agent_id: id },
          getSocketPath(),
          config.ipcPort,
        )

        if (response.type === 'ok') {
          console.log(`Agent ${id} started`)
        } else {
          throw new CliError(response.error || 'Failed to start agent', 1)
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to start agent:', err)
        process.exit(1)
      }
    })
}
