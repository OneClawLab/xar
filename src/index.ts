/**
 * xar CLI - Agent Runtime Daemon
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'
import { CliError } from './types.js'
import { createDaemonCommand } from './commands/daemon.js'
import { createInitCommand } from './commands/init.js'
import { createStartCommand } from './commands/start.js'
import { createStopCommand } from './commands/stop.js'
import { createStatusCommand } from './commands/status.js'
import { createListCommand } from './commands/list.js'
import { createSendCommand } from './commands/send.js'
import { createChatCommand } from './commands/chat.js'

// EPIPE handling
process.stdout.on('error', (err) => {
  if ((err as any).code === 'EPIPE') process.exit(0)
  throw err
})
process.stderr.on('error', (err) => {
  if ((err as any).code === 'EPIPE') process.exit(0)
  throw err
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))

const program = new Command()
  .name('xar')
  .description('xar - Agent Runtime Daemon for TheClaw v2')
  .version(pkg.version)

program.exitOverride()

// Add commands
program.addCommand(createDaemonCommand())
program.addCommand(createInitCommand())
program.addCommand(createStartCommand())
program.addCommand(createStopCommand())
program.addCommand(createStatusCommand())
program.addCommand(createListCommand())
program.addCommand(createSendCommand())
program.addCommand(createChatCommand())

// Propagate exitOverride to all subcommands (recursive)
function propagateExitOverride(cmd: Command): void {
  for (const sub of cmd.commands) {
    sub.exitOverride()
    propagateExitOverride(sub)
  }
}
propagateExitOverride(program)

// Error handling
program.on('error', (err) => {
  if (err instanceof CliError) {
    console.error(err.message)
    process.exit(err.exitCode)
  }
  console.error(err)
  process.exit(1)
})

// Parse arguments
try {
  await program.parseAsync(process.argv)
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(err.message + '\n')
    process.exit(err.exitCode)
  }

  // Handle commander errors (exitOverride mode)
  const commanderErr = err as { code?: string; exitCode?: number }
  if (commanderErr.code?.startsWith('commander.')) {
    // --help, --version → exit 0
    if (commanderErr.code === 'commander.helpDisplayed' || commanderErr.code === 'commander.version') {
      process.exit(0)
    }
    // Argument/usage errors → exit 2
    process.exit(2)
  }

  process.stderr.write(String(err instanceof Error ? err.message : err) + '\n')
  process.exit(1)
}
