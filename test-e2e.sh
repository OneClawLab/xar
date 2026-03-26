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
assert_file_exists "$AGENT_DIR/inbox/events.db" "inbox thread"

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

summary_and_exit
