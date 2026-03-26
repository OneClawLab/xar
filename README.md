# xar

Agent Runtime Daemon for TheClaw v2 — manages agent lifecycle, message routing, LLM calls, and streaming delivery.

## How it works

xar is a daemon that runs in the background and manages autonomous AI agents. Each agent has:

- **Inbox thread**: Receives incoming messages from external sources (via xgw)
- **LLM identity**: System prompt and configuration for the LLM
- **Message routing**: Routes messages to conversation threads based on routing config
- **Run-loop**: Processes messages sequentially, calls the LLM, and streams responses back

The daemon uses IPC (WebSocket over Unix socket with TCP fallback) to communicate with CLI commands and xgw.

## Install

### From npm

```bash
npm install -g @theclawlab/xar
```

### From source

```bash
npm run build && npm link
```

## Quick start

```bash
# Start the daemon
xar daemon start

# Initialize a new agent
xar init my-agent --kind user

# Start the agent (register with daemon)
xar start my-agent

# Check status
xar status my-agent

# Stop the agent
xar stop my-agent

# Stop the daemon
xar daemon stop
```

## Commands

### Daemon management

| Command | Description |
|---------|-------------|
| `xar daemon start` | Start xar daemon (background process) |
| `xar daemon stop` | Stop xar daemon (graceful shutdown) |
| `xar daemon status` | Check daemon status (PID, uptime, agents) |

### Agent management

| Command | Description |
|---------|-------------|
| `xar init <id>` | Initialize a new agent |
| `xar start <id>` | Start agent (register with daemon) |
| `xar stop <id>` | Stop agent (unregister from daemon) |
| `xar status [<id>]` | Show agent status (or list all agents) |
| `xar list` | List all initialized agents |

### Options

- `--json` — Output as JSON (for `status`, `list`, `daemon status`)
- `--kind <kind>` — Agent kind: `system` or `user` (for `init`, default: `user`)

## Data directory

Default: `~/.theclaw/` — override with `THECLAW_HOME` environment variable.

```
~/.theclaw/
├── xar.sock                    # IPC socket (Unix domain)
├── xar.pid                     # Daemon PID file
├── logs/
│   └── xar.log                 # Daemon log
└── agents/
    └── <agent_id>/
        ├── IDENTITY.md         # Agent system prompt
        ├── USAGE.md            # Usage notes
        ├── config.json         # Agent configuration
        ├── inbox/              # Inbox thread (SQLite)
        ├── sessions/           # LLM session files (JSONL)
        ├── memory/             # Persistent memory files
        ├── threads/            # Conversation threads
        ├── workdir/            # Temporary workspace
        └── logs/
            └── agent.log       # Agent run log
```

## Configuration

Agent configuration is stored in `~/.theclaw/agents/<id>/config.json`:

```json
{
  "agent_id": "my-agent",
  "kind": "user",
  "status": "stopped",
  "pai": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "routing": {
    "default": "per-peer"
  },
  "memory": {
    "compact_threshold_tokens": 8000,
    "session_compact_threshold_tokens": 4000
  },
  "retry": {
    "max_attempts": 3
  }
}
```

### Configuration fields

| Field | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Agent unique identifier |
| `kind` | `system` \| `user` | Agent type |
| `status` | `stopped` \| `started` | Current status |
| `pai.provider` | string | LLM provider (e.g., `openai`) |
| `pai.model` | string | Model name (e.g., `gpt-4o`) |
| `routing.default` | `per-peer` \| `per-session` \| `per-agent` | Message routing mode |
| `memory.compact_threshold_tokens` | number | Token threshold for memory compaction |
| `memory.session_compact_threshold_tokens` | number | Token threshold for session compaction |
| `retry.max_attempts` | number | Max LLM call retries |

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `THECLAW_HOME` | TheClaw data root directory | `~/.theclaw` |
| `XAR_IPC_PORT` | TCP fallback port (if Unix socket fails) | `18792` |
| `XAR_LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |

## Dependencies

Requires the following tools to be installed and on `PATH`:

- [`thread`](../thread) — Event queue library
- [`pai`](../pai) — LLM CLI library
- [`xgw`](../xgw) — Communication gateway (for external channel delivery)

## Architecture

### Message flow

```
xgw (external message)
  ↓
xar daemon (IPC)
  ↓
agent run-loop
  ├─ route message to thread
  ├─ build LLM context
  ├─ call pai.chat()
  ├─ stream tokens via IPC
  └─ write response to thread
  ↓
xgw (stream tokens)
```

### Concurrency model

- **Per-agent queues**: Each agent has its own async message queue
- **Per-agent run-loops**: Each agent processes messages sequentially
- **Concurrent agents**: Multiple agents can process messages in parallel
- **Graceful shutdown**: 30-second timeout for run-loops to complete

## Error handling

| Error | Exit code | Recovery |
|-------|-----------|----------|
| Daemon already running | 1 | Stop existing daemon first |
| Daemon not running | 1 | Start daemon with `xar daemon start` |
| Agent not found | 1 | Initialize agent with `xar init <id>` |
| LLM call failed | 1 | Retry with exponential backoff (up to 3 times) |
| Invalid arguments | 2 | Check command syntax with `xar --help` |

## Testing

Run end-to-end tests:

```bash
bash test-e2e.sh
```

Run unit tests:

```bash
npm test
```

Run with coverage:

```bash
npm run test:coverage
```

## Documentation

- [USAGE.md](./USAGE.md) — Full CLI reference and examples
- [SPECv2.md](./SPECv2.md) — Architecture and design specification

## License

MIT
