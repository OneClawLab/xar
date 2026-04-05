/**
 * Agent stop command
 */

import { Command } from 'commander'
import { getDaemonConfig } from '../config.js'
import { checkDaemonRunning } from '../daemon/pid.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'

export function createStopCommand(): Command {
  return new Command('stop')
    .description('Stop an agent')
    .argument('<id>', 'Agent ID')
    .action(async (id: string) => {
      try {
        const config = getDaemonConfig()

        // Check if daemon is running
        const isRunning = await checkDaemonRunning(config.theClawHome)
        if (!isRunning) {
          throw new CliError('Daemon is not running', 1)
        }

        // Send agent_stop message via IPC
        const response = await sendIpcMessage(
          { type: 'agent_stop', agent_id: id },
          config.ipcPort,
        )

        if (response.type === 'ok') {
          console.log(`Agent ${id} stopped`)
        } else if (response.type === 'error') {
          throw new CliError(response.error || 'Failed to stop agent', 1)
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to stop agent:', err)
        process.exit(1)
      }
    })
}
