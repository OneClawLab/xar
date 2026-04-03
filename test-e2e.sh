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
AID="e2e-test-$"
AGENT_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID"

on_cleanup() {
  # Stop daemon
  $XAR daemon stop 2>/dev/null || true
  # Clean up agent directories (including worker from 15d)
  rm -rf "$AGENT_DIR"
  rm -rf "${THECLAW_HOME:-$HOME/.theclaw}/agents/e2e-worker-"* 2>/dev/null || true
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
run_cmd $XAR start "no-such-agent-$"; assert_exit 1
run_cmd $XAR stop  "no-such-agent-$"; assert_exit 1
run_cmd $XAR status "no-such-agent-$"; assert_exit 1

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
# 15d. Agent-to-agent interaction via send_message tool
# ══════════════════════════════════════════════════════════════
# Full end-to-end flow per ARCH.md:
#
#   1. Prime worker with a secret number (8754) via internal message.
#   2. Human sends message to orchestrator asking for the number.
#   3. Orchestrator:
#      a. Replies to human immediately ("Let me check with the worker")
#         via implicit streaming (text response to external source).
#      b. Calls send_message(target='agent:<worker>') to delegate.
#   4. Worker receives internal message, processes it, and calls
#      send_message(target='agent:<orchestrator>') to reply with 8754.
#   5. Orchestrator receives worker's reply in its worker-thread,
#      and the session records 8754.
#
# Verification:
#   - Orchestrator's user-thread has an assistant reply (intermediate ack)
#   - Worker's session contains "8754" (worker knew and replied)
#   - Orchestrator's worker-thread session contains "8754" (reply arrived)
#
# Key: both agents use send_message tool explicitly (no auto-reply).
# IDENTITY.md prompts guide each agent's behavior.

AID_B="e2e-worker-$"
AGENT_B_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID_B"

section "15d. a2a — restart daemon for clean IPC connections"
run_cmd $XAR daemon stop 2>/dev/null; sleep 1; run_cmd $XAR daemon start
assert_exit0
sleep 1

section "15d. a2a — init worker agent"
run_cmd $XAR init "$AID_B"
assert_exit0
assert_file_exists "$AGENT_B_DIR/config.json" "worker config"

# Write worker IDENTITY: instructs it to use send_message to reply
cat >"$AGENT_B_DIR/IDENTITY.md" <<'WORKER_ID_EOF'
# Worker Agent

You are a worker agent in a multi-agent system.
You remember facts told to you and answer questions about them.

IMPORTANT: When you receive a message from another agent (internal message),
your text response is NOT automatically delivered. You MUST use the
send_message tool to reply. Check the Communication Context for the sender.

When asked a question by another agent, use send_message to send your answer back.
WORKER_ID_EOF

section "15d. a2a — start worker"
run_cmd $XAR start "$AID_B"
assert_exit0
sleep 2

section "15d. a2a — prime worker with secret number 8754"
# Send via internal source (as if orchestrator sent it) so worker stores it
# in the orchestrator's per-peer thread.
A2A_CONV_ID="a2a-conv-$"
WORKER_PRIME_SOURCE="internal:agent:${A2A_CONV_ID}:${AID}"
WORKER_ORCH_SESS="${AGENT_B_DIR}/sessions/peers/${AID}.jsonl"

run_cmd $XAR send "$AID_B" \
  "Please remember this number: 8754. Just confirm you stored it. Use send_message(target='agent:${AID}', content='Stored 8754') to confirm." \
  --source "$WORKER_PRIME_SOURCE"
assert_exit0
assert_contains "delivered"

wait_for "worker stored 8754" 60 \
  "grep -q 'assistant' \"$WORKER_ORCH_SESS\" 2>/dev/null" \
  -- "tail -10 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

run_cmd cat "$WORKER_ORCH_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — write orchestrator identity for delegation"
ORCH_IDENTITY="$AGENT_DIR/IDENTITY.md"
cat >"$ORCH_IDENTITY" <<ORCH_ID_EOF
# Orchestrator Agent

You coordinate tasks by delegating to worker agents using the send_message tool.

When a user asks you to get information from a worker:
1. First, reply to the user with a brief acknowledgment (your text response streams to the user).
2. Then use send_message(target='agent:${AID_B}', content='<your question>') to ask the worker.

When you receive a reply from another agent (internal message):
- Your text response is NOT auto-delivered for internal messages.
- The information will be recorded in your thread for future reference.

Available worker: agent:${AID_B}
ORCH_ID_EOF

section "15d. a2a — start orchestrator"
run_cmd $XAR start "$AID"
assert_exit0
sleep 2

section "15d. a2a — human asks orchestrator to get the number from worker"
A2A_SOURCE="external:cli:main:dm:${A2A_CONV_ID}:e2e-user"
ORCH_USER_SESS="${AGENT_DIR}/sessions/peers/e2e-user.jsonl"
ORCH_WORKER_SESS="${AGENT_DIR}/sessions/peers/${AID_B}.jsonl"

run_cmd $XAR send "$AID" \
  "Ask agent:${AID_B} what number it stored. Use send_message to ask it. Then tell me the answer." \
  --source "$A2A_SOURCE"
assert_exit0
assert_contains "delivered"

section "15d. a2a — wait for orchestrator to process user message and delegate"
# Orchestrator should produce an assistant reply (implicit streaming to user)
# and call send_message to delegate to worker.
wait_for "orchestrator processed user message" 60 \
  "grep -q 'assistant' \"$ORCH_USER_SESS\" 2>/dev/null" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — verify orchestrator replied to user (intermediate reply)"
run_cmd cat "$ORCH_USER_SESS"
assert_exit0
assert_contains "assistant"

section "15d. a2a — wait for worker to receive delegated question and reply"
# Worker receives internal message from orchestrator, processes it,
# and uses send_message to reply back with 8754.
# We check for at least 2 assistant entries (prime + delegation).
wait_for "worker processed delegated question" 90 \
  "grep -c 'assistant' \"$WORKER_ORCH_SESS\" 2>/dev/null | grep -q '[2-9]'" \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID_B}.log 2>/dev/null || echo 'no worker log'"

section "15d. a2a — verify worker session contains 8754"
run_cmd cat "$WORKER_ORCH_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — wait for orchestrator to receive worker reply"
# Worker's send_message routes to orchestrator's worker-thread.
# Wait for that session to appear with 8754.
wait_for "orchestrator received worker reply" 90 \
  'test -s "$ORCH_WORKER_SESS" 2>/dev/null && grep -q "8754" "$ORCH_WORKER_SESS" 2>/dev/null' \
  -- "tail -20 ${THECLAW_HOME:-$HOME/.theclaw}/logs/agent-${AID}.log 2>/dev/null || echo 'no orch log'"

section "15d. a2a — verify orchestrator worker-thread contains 8754"
run_cmd cat "$ORCH_WORKER_SESS"
assert_exit0
assert_contains "8754"

section "15d. a2a — stop agents"
sleep 3  # let agents drain any remaining queued messages
run_cmd $XAR stop "$AID_B" 2>/dev/null
[[ $EC -eq 0 || $EC -eq 1 ]] && pass "worker stopped (exit=$EC)" || fail "worker stop failed (exit=$EC)"
run_cmd $XAR stop "$AID" 2>/dev/null
[[ $EC -eq 0 || $EC -eq 1 ]] && pass "orchestrator stopped (exit=$EC)" || fail "orchestrator stop failed (exit=$EC)"
sleep 2

section "15d. a2a — final assertion: full chain verified"
# The complete a2a chain is proven:
#   human → orchestrator (intermediate reply) → send_message → worker
#   worker (8754) → send_message → orchestrator (worker-thread has 8754)
# Orchestrator could not have known 8754 without the worker replying via send_message.
run_cmd cat "$ORCH_WORKER_SESS"
assert_exit0
assert_contains "8754"
pass "Full agent-to-agent chain verified: human → orchestrator → worker → 8754 → orchestrator"

rm -rf "$AGENT_B_DIR" 2>/dev/null || true

summary_and_exit
