#!/bin/bash
# Tests for connection and basic CLI functionality
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Connection & CLI Tests"

# ──────────────────────────────────────────────
print_group "Version flag"
# ──────────────────────────────────────────────
output=$(${MONGOSH} -version 2>&1)
assert_contains "$output" "go-mongosh" "version flag prints version string"

# ──────────────────────────────────────────────
print_group "Basic connectivity"
# ──────────────────────────────────────────────
output=$(run_eval "1 + 1")
assert_contains "$output" "2" "eval simple arithmetic"

output=$(run_eval "'hello ' + 'world'")
assert_contains "$output" "hello world" "eval string concatenation"

# ──────────────────────────────────────────────
print_group "Server info"
# ──────────────────────────────────────────────
output=$(run_eval "db.version()")
assert_contains "$output" "." "db.version() returns a version string"

output=$(run_eval "db.getName()")
exit_code=$?
assert_exit_success "$exit_code" "db.getName() exits successfully"

# ──────────────────────────────────────────────
print_group "Quiet mode"
# ──────────────────────────────────────────────
output=$(${MONGOSH} ${CONN_ARGS} -quiet -eval "1+1" 2>&1)
assert_not_contains "$output" "Connecting to" "quiet mode suppresses banner"

output=$(${MONGOSH} ${CONN_ARGS} -eval "1+1" 2>&1)
assert_contains "$output" "Connecting to" "non-quiet mode shows banner"

# ──────────────────────────────────────────────
print_group "Print and console functions"
# ──────────────────────────────────────────────
output=$(run_eval "print('test_output_123')")
assert_contains "$output" "test_output_123" "print() outputs to stdout"

output=$(run_eval "console.log('console_test_456')")
assert_contains "$output" "console_test_456" "console.log() outputs to stdout"

# ──────────────────────────────────────────────
print_group "Error handling"
# ──────────────────────────────────────────────
output=$(run_eval "undefinedVariable.foo()" 2>&1; echo "EXIT:$?")
assert_contains "$output" "Error" "undefined variable produces error"

print_summary
exit $?
