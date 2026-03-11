#!/bin/bash
# Tests for database admin operations: adminCommand, currentOp,
# getCollection, help methods.
# Inspired by MongoDB jstests/core/administrative/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Database Admin Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"

setup_test_db

# ──────────────────────────────────────────────
print_group "adminCommand ping"
# ──────────────────────────────────────────────
output=$(run_eval "db.adminCommand({ping: 1})")
assert_contains "$output" "ok" "adminCommand ping returns ok"

# ──────────────────────────────────────────────
print_group "adminCommand serverStatus"
# ──────────────────────────────────────────────
output=$(run_eval "db.adminCommand({serverStatus: 1}).host")
exit_code=$?
assert_exit_success "$exit_code" "adminCommand serverStatus succeeds"

# ──────────────────────────────────────────────
print_group "currentOp"
# ──────────────────────────────────────────────
output=$(run_eval "db.currentOp()")
assert_contains "$output" "inprog" "currentOp returns inprog field"

# ──────────────────────────────────────────────
print_group "getCollection returns usable object"
# ──────────────────────────────────────────────
run_eval "${DB}.getCollection('admin_coll_test').insertOne({test: 'via_getCollection'})" > /dev/null
output=$(run_eval "${DB}.getCollection('admin_coll_test').findOne({test: 'via_getCollection'}).test")
assert_contains "$output" "via_getCollection" "getCollection returns functional collection"

# ──────────────────────────────────────────────
print_group "getSiblingDB chaining"
# ──────────────────────────────────────────────
output=$(run_eval "db.getSiblingDB('db_one').getSiblingDB('db_two').getName()")
assert_contains "$output" "db_two" "getSiblingDB chaining resolves to last db"

# ──────────────────────────────────────────────
print_group "db.help()"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.help()")
assert_contains "$output" "Database Methods" "db.help() shows Database Methods"
assert_contains "$output" "runCommand" "db.help() mentions runCommand"

# ──────────────────────────────────────────────
print_group "collection.help()"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.admin_coll_test.help()")
assert_contains "$output" "Collection Methods" "collection.help() shows Collection Methods"
assert_contains "$output" "find" "collection.help() mentions find"
assert_contains "$output" "insertOne" "collection.help() mentions insertOne"

teardown_test_db

print_summary
exit $?
