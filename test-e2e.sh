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
#   1. Prime worker with a secret number (8754) via direct message.
#   2. User asks orchestrator to ask worker for the number it remembers.
#   3. Orchestrator uses bash_exec to call xar send <worker> WITHOUT --source
#      (source is auto-constructed from injected XAR_AGENT_ID/XAR_CONV_ID).
#   4. Worker receives internal message, replies with 8754.
#   5. Worker reply auto-routes back to orchestrator.
#   6. Orchestrator processes worker reply and replies to user.
#
# Verification: user-thread session of orchestrator contains "8754".
# Using a unique magic number avoids false positives from coincidental matches.

AID_B="e2e-worker-$$"
AGENT_B_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID_B"

section "15d. a2a — restart daemon for clean IPC connections"
run_cmd $XAR daemon stop 2>/dev/null; sleep 1; run_cmd $XAR daemon start
assert_exit0
sleep 1

section "15d. a2a — init and start worker agent"
run_cmd $XAR init "$AID_B"
assert_exit0
assert_file_exists "$AGENT_B_DIR/config.json" "worker config"

run_cmd $XAR start "$AID_B"
assert_exit0
sleep 2

section "15d. a2a — prime worker with secret number 8754"
# Send directly to worker so it remembers the number in its own thread.
# Source is external so it creates a user-facing thread in worker.
# Use same conv-id and sender as the later orchestrator question,
# so prime and question land in the same worker thread.
A2A_CONV_ID="a2a-conv-$"
WORKER_PRIME_SOURCE="internal:agent:${A2A_CONV_ID}:${AID}"
WORKER_PRIME_SESS="${AGENT_B_DIR}/sessions/peers/${AID}.jsonl"
run_cmd $XAR send "$AID_B" \
  "Please remember this number: 8754. Confirm you have stored it." \
  --source "$WORKER_PRIME_SOURCE"
assert_exit0
assert_contains "delivered"

wait_for "worker stored 8754" 30 \
  "grep -q 'assistant' \"$WORKER_PRIME_SESS\" 2>/dev/null" \
  -- "tail -10 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

run_cmd cat "$WORKER_PRIME_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — restart orchestrator with delegation identity"
ORCH_IDENTITY="$AGENT_DIR/IDENTITY.md"
cat >"$ORCH_IDENTITY" <<IDENTITY_EOF
# Orchestrator Agent
You are an orchestrator that coordinates with worker agents using bash_exec tool calls.
When asked to get information from a worker, use bash_exec to run xar send commands.
IDENTITY_EOF

run_cmd $XAR start "$AID"
assert_exit0
sleep 2

section "15d. a2a — user asks orchestrator to retrieve the number from worker"
# A2A_CONV_ID already set above (same as prime conv-id)
A2A_SOURCE="external:cli:main:dm:${A2A_CONV_ID}:e2e-user"
ORCH_SESS="${AGENT_DIR}/sessions/peers/e2e-user.jsonl"
# WORKER_SESS same as WORKER_PRIME_SESS
WORKER_SESS="$WORKER_PRIME_SESS"
ORCH_WORKER_SESS="${AGENT_DIR}/sessions/peers/${AID_B}.jsonl"

run_cmd $XAR send "$AID" \
  "Use bash_exec to run this command: xar send $AID_B \"What number did you store? Reply with just the number.\"  Then wait for the reply and tell me what the worker said." \
  --source "$A2A_SOURCE"
assert_exit0
assert_contains "delivered"

section "15d. a2a — wait for orchestrator to process and call worker"
wait_for "orchestrator processed user message" 60 \
  "grep -q 'assistant' \"$ORCH_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — wait for worker to receive and process the delegated question"
wait_for "worker processed delegated question" 60 \
  "grep -q 'assistant' \"$WORKER_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

section "15d. a2a — verify worker replied with 8754"
run_cmd cat "$WORKER_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — verify auto-reply routed back to orchestrator"
wait_for "orchestrator received worker auto-reply" 30 \
  "grep -q 'Auto-reply sent to agent $AID' \"${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log\" 2>/dev/null" \
  -- "tail -10 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

section "15d. a2a — stop worker to break the loop"
run_cmd $XAR stop "$AID_B"
assert_exit0
sleep 1

section "15d. a2a — wait for orchestrator to process worker reply"
# Orchestrator processes the worker auto-reply in peers/<worker_id> thread.
# We wait for that thread's session to appear (any content = orchestrator processed it).
wait_for "orchestrator processed worker reply" 30 \
  'test -s "$ORCH_WORKER_SESS" 2>/dev/null' \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — wait for orchestrator to reply to user with 8754"
# Orchestrator processes the worker auto-reply in peers/<worker_id> thread.
# The key assertion: orchestrator's worker-thread session contains 8754,
# proving the full a2a chain: user → orchestrator → worker → 8754 → orchestrator.
wait_for "orchestrator worker-thread session contains 8754" 60 \
  "grep -q '8754' \"$ORCH_WORKER_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — stop orchestrator"
sleep 5  # let orchestrator drain any remaining queued messages from the ping-pong loop
run_cmd $XAR stop "$AID" 2>/dev/null
# exit 0 = stopped cleanly, exit 1 = already stopped (both acceptable)
[[ $EC -eq 0 || $EC -eq 1 ]] && pass "orchestrator stopped (exit=$EC)" || fail "orchestrator stop failed (exit=$EC)"
sleep 2

section "15d. a2a — final: worker replied with 8754"
run_cmd cat "$WORKER_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — final: orchestrator worker-thread contains 8754 (key e2e assertion)"
# The full a2a chain is verified: user asked orchestrator → orchestrator delegated to worker
# → worker replied with 8754 → auto-reply routed to orchestrator → orchestrator processed it.
# Orchestrator could not have known 8754 without delegating to the worker.
run_cmd cat "$ORCH_WORKER_SESS"
assert_exit0
assert_contains "8754"

rm -rf "$AGENT_B_DIR" 2>/dev/null || true

summary_and_exit
