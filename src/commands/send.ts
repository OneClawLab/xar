/**
 * xar send <id> - Send a message to an agent's inbox via IPC
 *
 * Convenience command for local testing/debugging.
 * Constructs a minimal InboundMessage and delivers it to the daemon.
 *
 * Usage:
 *   xar send <id> "hello"
 *   xar send <id> "hello" --source peer:cli --channel cli --peer cli
 */

import { Command } from 'commander'
import { getDaemonConfig, getSocketPath } from '../config.js'
import { checkDaemonRunning } from '../daemon/pid.js'
import { sendIpcMessage } from '../ipc/client.js'
import { CliError } from '../types.js'

export function createSendCommand(): Command {
  return new Command('send')
    .description('Send a message to an agent (for testing/debugging)')
    .argument('<id>', 'Agent ID')
    .argument('<message>', 'Message content')
    .option('--source <source>', 'Source address', 'peer:cli')
    .option('--channel <channel>', 'Channel ID for reply_context', 'cli')
    .option('--peer <peer>', 'Peer ID for reply_context', 'cli')
    .option('--session <session>', 'Session ID for reply_context', 'cli')
    .action(async (id: string, message: string, opts: {
      source: string
      channel: string
      peer: string
      session: string
    }) => {
      try {
        const config = getDaemonConfig()

        const isRunning = await checkDaemonRunning(config.theClawHome)
        if (!isRunning) {
          throw new CliError('Daemon is not running. Run "xar daemon start" first', 1)
        }

        const response = await sendIpcMessage(
          {
            type: 'inbound_message',
            agent_id: id,
            message: {
              source: opts.source,
              content: message,
              reply_context: {
                channel_type: 'internal',
                channel_id: opts.channel,
                session_type: 'dm',
                session_id: opts.session,
                peer_id: opts.peer,
              },
            },
          },
          getSocketPath(),
          config.ipcPort,
        )

        if (response.type === 'ok') {
          console.log(`Message delivered to agent ${id}`)
        } else {
          throw new CliError(response.error ?? 'Failed to deliver message', 1)
        }
      } catch (err) {
        if (err instanceof CliError) {
          console.error(err.message)
          process.exit(err.exitCode)
        }
        console.error('Failed to send message:', err)
        process.exit(1)
      }
    })
}
