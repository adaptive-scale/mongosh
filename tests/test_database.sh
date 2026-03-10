#!/bin/bash
# Tests for database-level operations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Database Operations Tests"

setup_test_db

# ──────────────────────────────────────────────
print_group "List databases"
# ──────────────────────────────────────────────
# First create a collection so the DB appears in the list
run_eval "db.getSiblingDB('${TEST_DB}').test_setup.insertOne({init: true})" > /dev/null

output=$(run_eval "db.getMongo().getDBNames()")
assert_contains "$output" "admin" "database list contains admin"

# ──────────────────────────────────────────────
print_group "Switch database"
# ──────────────────────────────────────────────
output=$(run_eval "db.getSiblingDB('${TEST_DB}').getName()")
assert_contains "$output" "${TEST_DB}" "getSiblingDB switches to test database"

# ──────────────────────────────────────────────
print_group "Create and list collections"
# ──────────────────────────────────────────────
run_eval "db.getSiblingDB('${TEST_DB}').createCollection('test_coll_alpha')" > /dev/null
output=$(run_eval "db.getSiblingDB('${TEST_DB}').getCollectionNames()")
assert_contains "$output" "test_coll_alpha" "created collection appears in list"

# ──────────────────────────────────────────────
print_group "Database stats"
# ──────────────────────────────────────────────
output=$(run_eval "db.getSiblingDB('${TEST_DB}').stats()")
assert_contains "$output" "db" "db.stats() returns result with db field"

# ──────────────────────────────────────────────
print_group "Run command"
# ──────────────────────────────────────────────
output=$(run_eval "db.getSiblingDB('${TEST_DB}').runCommand({ping: 1})")
assert_contains "$output" "ok" "runCommand ping returns ok"

# ──────────────────────────────────────────────
print_group "Server status"
# ──────────────────────────────────────────────
output=$(run_eval "db.serverStatus().host")
exit_code=$?
assert_exit_success "$exit_code" "db.serverStatus() succeeds"

# ──────────────────────────────────────────────
print_group "Drop database"
# ──────────────────────────────────────────────
run_eval "db.getSiblingDB('${TEST_DB}_drop_test').drop_test_col.insertOne({a:1})" > /dev/null
output=$(run_eval "db.getSiblingDB('${TEST_DB}_drop_test').dropDatabase()")
assert_contains "$output" "ok" "dropDatabase returns ok"

teardown_test_db

print_summary
exit $?
