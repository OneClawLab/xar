# xar Usage Guide

Complete reference for xar CLI commands and workflows.

## Table of Contents

1. [Daemon Management](#daemon-management)
2. [Agent Management](#agent-management)
3. [Configuration](#configuration)
4. [Workflows](#workflows)
5. [Troubleshooting](#troubleshooting)

---

## Daemon Management

The xar daemon runs in the background and manages all agents.

### Start daemon

```bash
xar daemon start
```

Starts the daemon as a background process. The daemon:
- Writes PID to `~/.theclaw/xar.pid`
- Listens on TCP `127.0.0.1:18792`
- Loads all agents with status `started`
- Starts run-loops for each agent

**Exit codes:**
- `0` — Success
- `1` — Daemon already running

### Stop daemon

```bash
xar daemon stop
```

Stops the daemon gracefully:
- Sends SIGTERM to daemon process
- Waits up to 30 seconds for run-loops to complete
- Sends SIGKILL if timeout exceeded
- Cleans up PID file

**Exit codes:**
- `0` — Success
- `1` — Daemon not running

### Check daemon status

```bash
xar daemon status
xar daemon status --json
```

Shows daemon status:
- PID and uptime
- List of running agents

**Output (text):**
```
Daemon is running (PID: 12345)
Uptime: 3600s
Agents: admin, my-agent
```

**Output (JSON):**
```json
{
  "pid": 12345,
  "uptime": 3600,
  "agents": ["admin", "my-agent"]
}
```

---

## Agent Management

### Initialize agent

```bash
xar init <id>
xar init <id> --kind system
xar init <id> --kind user
```

Creates a new agent directory structure:
- `~/.theclaw/agents/<id>/config.json` — Configuration
- `~/.theclaw/agents/<id>/IDENTITY.md` — System prompt
- `~/.theclaw/agents/<id>/USAGE.md` — Usage notes
- `~/.theclaw/agents/<id>/inbox/` — Inbox thread (SQLite)
- `~/.theclaw/agents/<id>/sessions/` — LLM session files
- `~/.theclaw/agents/<id>/memory/` — Memory files
- `~/.theclaw/agents/<id>/threads/` — Conversation threads
- `~/.theclaw/agents/<id>/logs/` — Agent logs

**Options:**
- `--kind system` — System agent (default: `user`)
- `--kind user` — User-defined agent
- `--provider <name>` — LLM provider name (default: from `pai model default`)
- `--model <name>` — LLM model name (default: from pai provider config)

Provider and model are read from `pai model default` if not specified. If no default is configured, `--provider` and `--model` are required.

**Exit codes:**
- `0` — Success
- `1` — Agent already exists, or no provider/model configured
- `2` — Invalid arguments

**Example:**
```bash
xar init admin --kind system
xar init my-agent --kind user
xar init my-agent --kind user --provider my-azure --model gpt-5.2
```

### Start agent

```bash
xar start <id>
```

Registers the agent with the daemon:
- Sends `agent_start` message via IPC
- Daemon creates message queue and starts run-loop
- Agent status changes to `started`

**Prerequisites:**
- Daemon must be running (`xar daemon start`)
- Agent must be initialized (`xar init <id>`)

**Exit codes:**
- `0` — Success
- `1` — Daemon not running or agent not found
- `2` — Invalid arguments

**Example:**
```bash
xar daemon start
xar init my-agent
xar start my-agent
```

### Stop agent

```bash
xar stop <id>
```

Unregisters the agent from the daemon:
- Sends `agent_stop` message via IPC
- Daemon stops accepting new messages for this agent
- Waits for current message to complete
- Stops run-loop
- Agent status changes to `stopped`

**Exit codes:**
- `0` — Success
- `1` — Daemon not running or agent not found
- `2` — Invalid arguments

**Example:**
```bash
xar stop my-agent
```

### Check agent status

```bash
xar status
xar status <id>
xar status <id> --json
```

Shows agent status:
- Without `<id>`: Lists all agents with status
- With `<id>`: Shows detailed status for one agent

**Output (text, all agents):**
```
admin       started
my-agent    stopped
```

**Output (text, single agent):**
```
Agent:    my-agent (user)
Dir:      ~/.theclaw/agents/my-agent
Status:   stopped
Provider: my-azure / gpt-5.2
Routing:  per-peer
Inbox:    0 events (last: never)
Sessions: 0 session file(s)
```

**Output (JSON):**
```json
{
  "agent_id": "my-agent",
  "kind": "user",
  "dir": "~/.theclaw/agents/my-agent",
  "pai": {
    "provider": "my-azure",
    "model": "gpt-5.2"
  },
  "inbox": { "eventCount": 0, "lastEventId": null, "lastEventAt": null }
}
```

**Exit codes:**
- `0` — Success
- `1` — Agent not found
- `2` — Invalid arguments

### List agents

```bash
xar list
xar list --json
```

Lists all initialized agents.

**Output (text):**
```
admin
my-agent
test-agent
```

**Output (JSON):**
```json
[
  {
    "id": "admin",
    "kind": "system",
    "status": "stopped"
  },
  {
    "id": "my-agent",
    "kind": "user",
    "status": "stopped"
  }
]
```

**Exit codes:**
- `0` — Success
- `2` — Invalid arguments

---

## Configuration

### Agent config file

Located at `~/.theclaw/agents/<id>/config.json`:

```json
{
  "agent_id": "my-agent",
  "kind": "user",
  "pai": {
    "provider": "my-azure",
    "model": "gpt-5.2"
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

### Routing modes

**per-peer** (default)
- One thread per peer, regardless of session
- All conversations with a peer go to the same thread
- Good for maintaining context across sessions

**per-session**
- One thread per session
- Each session has its own conversation thread
- Good for isolated conversations

**per-agent**
- Single thread for entire agent
- All messages go to the same thread
- Good for simple agents with single conversation

### Memory settings

- `compact_threshold_tokens` — Trigger cross-session memory compaction (default: 8000)
- `session_compact_threshold_tokens` — Trigger session-level compaction (default: 4000)

### Retry settings

- `max_attempts` — Maximum LLM call retries (default: 3)
- Uses exponential backoff: 2^attempt * 1000ms

---

## Workflows

### Basic workflow

```bash
# 1. Start daemon
xar daemon start

# 2. Initialize agent
xar init my-agent

# 3. Start agent
xar start my-agent

# 4. Check status
xar status my-agent

# 5. Stop agent
xar stop my-agent

# 6. Stop daemon
xar daemon stop
```

### Multiple agents

```bash
# Start daemon
xar daemon start

# Initialize multiple agents
xar init admin --kind system
xar init assistant --kind user
xar init helper --kind user

# Start all agents
xar start admin
xar start assistant
xar start helper

# Check all statuses
xar status

# Stop specific agent
xar stop assistant

# Stop all agents
xar stop admin
xar stop helper

# Stop daemon
xar daemon stop
```

### Custom configuration

```bash
# Initialize agent
xar init my-agent

# Edit config
nano ~/.theclaw/agents/my-agent/config.json

# Change routing mode
# "routing": { "default": "per-session" }

# Change LLM model
# "pai": { "model": "gpt-4-turbo" }

# Start agent with new config
xar start my-agent
```

### Debugging

```bash
# Check daemon status
xar daemon status --json

# Check agent status
xar status my-agent --json

# View agent logs
tail -f ~/.theclaw/agents/my-agent/logs/agent.log

# View daemon logs
tail -f ~/.theclaw/logs/xar.log

# List all agents
xar list --json
```

---

## Troubleshooting

### Daemon won't start

**Error:** `Daemon is already running`

**Solution:** Stop existing daemon first:
```bash
xar daemon stop
xar daemon start
```

**Error:** `Failed to start daemon`

**Solution:** Check logs:
```bash
tail -f ~/.theclaw/logs/xar.log
```

### Agent won't start

**Error:** `Daemon is not running`

**Solution:** Start daemon first:
```bash
xar daemon start
xar start my-agent
```

**Error:** `Agent not found`

**Solution:** Initialize agent first:
```bash
xar init my-agent
xar start my-agent
```

### IPC connection issues

**Error:** `Failed to connect to daemon`

**Solution:** Check if daemon is running:
```bash
xar daemon status
```

If not running, start it:
```bash
xar daemon start
```

### LLM call failures

**Error:** `LLM call failed`

**Solution:** Check agent logs:
```bash
tail -f ~/.theclaw/agents/my-agent/logs/agent.log
```

Check pai configuration:
```bash
pai model default --json
```

### Memory issues

**Error:** `Out of memory`

**Solution:** Reduce memory thresholds in config:
```json
{
  "memory": {
    "compact_threshold_tokens": 4000,
    "session_compact_threshold_tokens": 2000
  }
}
```

### Port conflicts

**Error:** `Address already in use`

**Solution:** Use different TCP port:
```bash
XAR_IPC_PORT=18793 xar daemon start
```

---

## Environment variables

```bash
# Set TheClaw home directory
export THECLAW_HOME=~/.theclaw

# Set IPC TCP port
export XAR_IPC_PORT=18792

# Set log level
export XAR_LOG_LEVEL=debug

# Run daemon with custom settings
XAR_LOG_LEVEL=debug xar daemon start
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (daemon not running, agent not found, etc.) |
| `2` | Usage error (invalid arguments, missing required option, etc.) |

---

## See also

- [README.md](./README.md) — Overview and quick start
- [SPECv2.md](./SPECv2.md) — Architecture and design
