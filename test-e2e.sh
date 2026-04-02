#!/usr/bin/env bash
#
# xar CLI End-to-End Test Script — daemon and agent lifecycle
#
# Prerequisites:
#   - xar built: npm run build
#   - thread installed globally: npm run release:local (in thread repo)
#   - pai installed globally with a default provider configured
#
# Usage: bash test-e2e.sh
#
set -uo pipefail

source "$(dirname "$0")/scripts/e2e-lib.sh"

XAR="xar"
AID="e2e-test-$$"
AGENT_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID"

on_cleanup() {
  # Stop daemon
  $XAR daemon stop 2>/dev/null || true
  # Clean up agent directory
  rm -rf "$AGENT_DIR"
}

setup_e2e

# ── Pre-flight ────────────────────────────────────────────────
section "Pre-flight"

require_bin $XAR "run npm run build"
require_bin thread "run: cd ../thread && npm run release:local"

PROVIDER=$(pai model default --json 2>/dev/null | json_field_from_stdin "defaultProvider")
if [[ -z "$PROVIDER" ]]; then fail "No default provider — run: pai model default --name <provider>"; exit 1; fi
pass "Default provider: $PROVIDER"

# Ensure no stale daemon from a previous run
$XAR daemon stop 2>/dev/null || true
sleep 1

# ══════════════════════════════════════════════════════════════
# 1. daemon start
# ══════════════════════════════════════════════════════════════
section "1. daemon start"
run_cmd $XAR daemon start
assert_exit0
sleep 1  # Give daemon time to start

# ══════════════════════════════════════════════════════════════
# 2. daemon status
# ══════════════════════════════════════════════════════════════
section "2. daemon status"
run_cmd $XAR daemon status
assert_exit0
assert_contains "running"

# ══════════════════════════════════════════════════════════════
# 3. daemon status --json
# ══════════════════════════════════════════════════════════════
section "3. daemon status --json"
run_cmd $XAR daemon status --json
assert_exit0
assert_json_field "$OUT" "pid"

# ══════════════════════════════════════════════════════════════
# 4. init
# ══════════════════════════════════════════════════════════════
section "4. init"
run_cmd $XAR init "$AID"
assert_exit0
assert_file_exists "$AGENT_DIR/config.json" "config.json"
assert_file_exists "$AGENT_DIR/IDENTITY.md" "IDENTITY.md"
assert_file_exists "$AGENT_DIR/USAGE.md" "USAGE.md"

# ══════════════════════════════════════════════════════════════
# 5. init — duplicate exits 1
# ══════════════════════════════════════════════════════════════
section "5. init — duplicate"
run_cmd $XAR init "$AID"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# 6. list
# ══════════════════════════════════════════════════════════════
section "6. list"
run_cmd $XAR list
assert_exit0
assert_contains "$AID"

# ══════════════════════════════════════════════════════════════
# 7. list --json
# ══════════════════════════════════════════════════════════════
section "7. list --json"
run_cmd $XAR list --json
assert_exit0
assert_json_array

# ══════════════════════════════════════════════════════════════
# 8. status (all agents)
# ══════════════════════════════════════════════════════════════
section "8. status"
run_cmd $XAR status
assert_exit0
assert_contains "$AID"

# ══════════════════════════════════════════════════════════════
# 9. status <id>
# ══════════════════════════════════════════════════════════════
section "9. status <id>"
run_cmd $XAR status "$AID"
assert_exit0
assert_nonempty

# ══════════════════════════════════════════════════════════════
# 10. status <id> --json
# ══════════════════════════════════════════════════════════════
section "10. status <id> --json"
run_cmd $XAR status "$AID" --json
assert_exit0
assert_json_field "$OUT" "agent_id"

# ══════════════════════════════════════════════════════════════
# 11. start
# ══════════════════════════════════════════════════════════════
section "11. start"
run_cmd $XAR start "$AID"
assert_exit0
sleep 1  # Give run-loop time to start

# ══════════════════════════════════════════════════════════════
# 12. status — agent should be running
# ══════════════════════════════════════════════════════════════
section "12. status — agent running"
run_cmd $XAR status "$AID"
assert_exit0
assert_contains "running"

# ══════════════════════════════════════════════════════════════
# 13. stop
# ══════════════════════════════════════════════════════════════
section "13. stop"
run_cmd $XAR stop "$AID"
assert_exit0
sleep 1

# ══════════════════════════════════════════════════════════════
# 14. status — agent should be stopped
# ══════════════════════════════════════════════════════════════
section "14. status — agent stopped"
run_cmd $XAR status "$AID"
assert_exit0
assert_contains "stopped"

# ══════════════════════════════════════════════════════════════
# 15. Error — operations on non-existent agent exit 1
# ══════════════════════════════════════════════════════════════
section "15. Error — operations on non-existent agent"
run_cmd $XAR start "no-such-agent-$$"; assert_exit 1
run_cmd $XAR stop  "no-such-agent-$$"; assert_exit 1
run_cmd $XAR status "no-such-agent-$$"; assert_exit 1

# ══════════════════════════════════════════════════════════════
# 16. daemon stop
# ══════════════════════════════════════════════════════════════
section "16. daemon stop"
run_cmd $XAR daemon stop
assert_exit0
sleep 1

# ══════════════════════════════════════════════════════════════
# 17. daemon status — should be stopped
# ══════════════════════════════════════════════════════════════
section "17. daemon status — stopped"
run_cmd $XAR daemon status
assert_exit 1

# ══════════════════════════════════════════════════════════════
# 15b. xar send — message delivery via IPC
# ══════════════════════════════════════════════════════════════
section "15b. xar send — restart daemon"
run_cmd $XAR daemon start
assert_exit0
sleep 1

section "15b. xar send — start agent"
run_cmd $XAR start "$AID"
assert_exit0
sleep 2

section "15b. xar send — successful delivery"
run_cmd $XAR send "$AID" "ping" --source external:cli:main:dm:e2e:e2e-user
assert_exit0
assert_contains "delivered"

section "15b. xar send — message appears in inbox"
# Verify via agent log that the message was received (avoids SQLite lock on Windows)
wait_for "agent received ping" 15 \
  'grep -q "Processing message" "${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log" 2>/dev/null' \
  -- "tail -10 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no log'"
pass "message delivered and processed"

section "15b. xar send — non-existent agent exits 1"
run_cmd $XAR send "no-such-agent-$" "hello" --source external:cli:main:dm:e2e:e2e-user
assert_exit 1

section "15b. xar send — stop agent"
run_cmd $XAR stop "$AID"
assert_exit0
sleep 1


# ══════════════════════════════════════════════════════════════
# 15c. bash_exec env injection — XAR_AGENT_ID and XAR_CONV_ID
# ══════════════════════════════════════════════════════════════
# Verify that when the agent calls bash_exec, the subprocess
# receives XAR_AGENT_ID (= agent id) and XAR_CONV_ID (= conversation_id
# extracted from the inbound source address).
# Source: external:cli:main:dm:conv-e2e-test:peer-1
#   -> XAR_AGENT_ID = $AID
#   -> XAR_CONV_ID  = conv-e2e-test  (the conversation_id segment)

E2E_CONV_ID="conv-e2e-test"
E2E_SOURCE="external:cli:main:dm:${E2E_CONV_ID}:peer-1"
SESS_FILE="${AGENT_DIR}/sessions/peers/peer-1.jsonl"

section "15c. bash_exec env injection — restart agent"
run_cmd $XAR start "$AID"
assert_exit0
sleep 2

section "15c. bash_exec env injection — send prompt"
run_cmd $XAR send "$AID" \
  "Use the bash_exec tool to run this exact command: echo XAR_AGENT_ID=\$XAR_AGENT_ID XAR_CONV_ID=\$XAR_CONV_ID. Then reply with the exact output." \
  --source "$E2E_SOURCE"
assert_exit0
assert_contains "delivered"

section "15c. bash_exec env injection — wait for reply"
wait_for "agent replied with env vars" 60 \
  'grep -q "assistant" "$SESS_FILE" 2>/dev/null' \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no log'"

section "15c. bash_exec env injection — verify XAR_AGENT_ID"
run_cmd cat "$SESS_FILE"
assert_exit0
assert_contains "XAR_AGENT_ID=$AID"

section "15c. bash_exec env injection — verify XAR_CONV_ID"
run_cmd cat "$SESS_FILE"
assert_exit0
assert_contains "XAR_CONV_ID=$E2E_CONV_ID"

section "15c. bash_exec env injection — stop agent"
run_cmd $XAR stop "$AID"
assert_exit0
sleep 1


# ══════════════════════════════════════════════════════════════
# 15d. Agent-to-agent interaction
# ══════════════════════════════════════════════════════════════
# Scenario:
#   orchestrator (AID) receives a user message.
#   Its IDENTITY instructs it to use bash_exec to call
#   "xar send <worker> <msg>" WITHOUT --source.
#   xar send picks up XAR_AGENT_ID and XAR_CONV_ID from the injected
#   env to construct an internal source automatically.
#   worker (AID_B) receives the internal message, processes it, and its
#   reply is auto-routed back to orchestrator by the daemon.
#
# Verification:
#   - Worker session file exists and has content (worker processed the message)
#   - Orchestrator log shows it received the auto-reply from worker
#   - Orchestrator session has ≥4 lines (user msg + orch reply + worker reply + orch reply)

AID_B="e2e-worker-$$"
AGENT_B_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID_B"

section "15d. a2a — init and start worker agent"
run_cmd $XAR init "$AID_B"
assert_exit0
assert_file_exists "$AGENT_B_DIR/config.json" "worker config"

run_cmd $XAR start "$AID_B"
assert_exit0
sleep 2

section "15d. a2a — restart orchestrator with delegation identity"
# Write IDENTITY before starting so the agent loads it fresh
ORCH_IDENTITY="$AGENT_DIR/IDENTITY.md"
cat >"$ORCH_IDENTITY" <<IDENTITY_EOF
# Orchestrator Agent

Your job: when you receive any message, use bash_exec to delegate to the worker agent.

Step 1 — delegate: run this bash command (do not add --source flag):
  xar send $AID_B "What is 2+2? Reply with just the number."

Step 2 — after running the command, reply to the user: "Delegated to worker, awaiting reply."

When you later receive a follow-up message from the worker (source will be internal), reply:
"Worker answered: <worker reply content>"
IDENTITY_EOF

run_cmd $XAR start "$AID"
assert_exit0
sleep 2

section "15d. a2a — send user message to orchestrator"
A2A_CONV_ID="a2a-conv-$$"
A2A_SOURCE="external:cli:main:dm:${A2A_CONV_ID}:e2e-user"
ORCH_SESS="${AGENT_DIR}/sessions/peers/e2e-user.jsonl"

run_cmd $XAR send "$AID" "Please delegate to the worker." --source "$A2A_SOURCE"
assert_exit0
assert_contains "delivered"

section "15d. a2a — wait for orchestrator to process and call worker"
wait_for "orchestrator processed user message" 60 \
  "grep -q 'assistant' \"$ORCH_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — verify orchestrator processed user message"
run_cmd cat "$ORCH_SESS"
assert_exit0
assert_nonempty

section "15d. a2a — wait for worker to receive and process the delegated message"
# Worker session path: per-peer routing, peer = orchestrator agent id
WORKER_SESS="${AGENT_B_DIR}/sessions/peers/${AID}.jsonl"
wait_for "worker processed delegated message" 60 \
  "grep -q 'assistant' \"$WORKER_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

section "15d. a2a — verify worker session has content"
run_cmd cat "$WORKER_SESS"
assert_exit0
assert_nonempty

section "15d. a2a — verify auto-reply routed back to orchestrator"
# Daemon log should show auto-reply from worker to orchestrator
wait_for "orchestrator received worker auto-reply" 30 \
  "grep -q 'Auto-reply sent to agent $AID' \"${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log\" 2>/dev/null" \
  -- "tail -10 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

section "15d. a2a — stop agents to prevent infinite loop"
# Stop both agents now — the a2a chain is proven (worker received, processed, auto-replied).
# Stopping prevents the orchestrator↔worker ping-pong loop.
run_cmd $XAR stop "$AID_B"
assert_exit0
run_cmd $XAR stop "$AID"
assert_exit0
sleep 2

section "15d. a2a — verify orchestrator worker-thread session has content"
# Worker reply routes to orchestrator's peers/<worker_id> thread
ORCH_WORKER_SESS="${AGENT_DIR}/sessions/peers/${AID_B}.jsonl"
run_cmd cat "$ORCH_WORKER_SESS"
assert_exit0
assert_nonempty

rm -rf "$AGENT_B_DIR" 2>/dev/null || true


summary_and_exit
