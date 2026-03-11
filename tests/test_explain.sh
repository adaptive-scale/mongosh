#!/bin/bash
# Tests for the explain() proxy on collections.
# Inspired by MongoDB jstests/core/query/explain/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Explain Proxy Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.explain_test"

setup_test_db

# Seed data
run_eval "${COLL}.insertMany([
    {name: 'Alice', score: 10, dept: 'eng'},
    {name: 'Bob', score: 20, dept: 'eng'},
    {name: 'Charlie', score: 30, dept: 'sales'}
])" > /dev/null

run_eval "${COLL}.createIndex({name: 1})" > /dev/null

# ──────────────────────────────────────────────
print_group "explain().find() default verbosity"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain().find({})")
assert_contains "$output" "queryPlanner" "default explain: contains queryPlanner"

# ──────────────────────────────────────────────
print_group "explain().find() with filter"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain().find({name: 'Alice'})")
assert_contains "$output" "queryPlanner" "explain with filter: contains queryPlanner"

# ──────────────────────────────────────────────
print_group "explain('executionStats').find()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain('executionStats').find({name: 'Bob'})")
assert_contains "$output" "executionStats" "executionStats verbosity: contains executionStats"

# ──────────────────────────────────────────────
print_group "explain('allPlansExecution').find()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain('allPlansExecution').find({score: {\\\$gt: 10}})")
assert_contains "$output" "allPlansExecution\|queryPlanner" "allPlansExecution: returns plan info"

# ──────────────────────────────────────────────
print_group "explain().aggregate()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain().aggregate([{\\\$match: {dept: 'eng'}}])")
assert_contains "$output" "queryPlanner\|stages" "explain aggregate: returns plan info"

# ──────────────────────────────────────────────
print_group "explain().aggregate() multi-stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.explain().aggregate([
    {\\\$match: {score: {\\\$gte: 10}}},
    {\\\$group: {_id: '\\\$dept', total: {\\\$sum: '\\\$score'}}}
])")
exit_code=$?
assert_exit_success "$exit_code" "explain multi-stage aggregate: succeeds"
assert_contains "$output" "queryPlanner\|stages" "explain multi-stage: returns plan info"

teardown_test_db

print_summary
exit $?
