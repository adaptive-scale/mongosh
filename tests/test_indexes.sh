#!/bin/bash
# Tests for index operations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Index Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.index_test"

setup_test_db

# Seed data
run_eval "${COLL}.insertMany([
    {name: 'Alice', age: 30, email: 'alice@test.com'},
    {name: 'Bob', age: 25, email: 'bob@test.com'},
    {name: 'Charlie', age: 35, email: 'charlie@test.com'}
])" > /dev/null

# ──────────────────────────────────────────────
print_group "createIndex"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.createIndex({name: 1})")
assert_contains "$output" "name_1" "createIndex on name returns index name"

output=$(run_eval "${COLL}.createIndex({email: 1}, {unique: true})")
assert_contains "$output" "email_1" "createIndex with unique option returns index name"

output=$(run_eval "${COLL}.createIndex({age: -1, name: 1})")
assert_contains "$output" "age_-1_name_1" "compound index created successfully"

# ──────────────────────────────────────────────
print_group "getIndexes"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.getIndexes()")
assert_contains "$output" "_id_" "getIndexes shows default _id index"
assert_contains "$output" "name_1" "getIndexes shows name index"
assert_contains "$output" "email_1" "getIndexes shows email index"

# ──────────────────────────────────────────────
print_group "dropIndex"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.dropIndex('name_1')")
assert_contains "$output" "ok" "dropIndex returns ok"

output=$(run_eval "${COLL}.getIndexes()")
assert_not_contains "$output" '"name_1"' "dropped index no longer in list"

# ──────────────────────────────────────────────
print_group "dropIndexes (all non-_id)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.dropIndexes()")
assert_contains "$output" "ok" "dropIndexes returns ok"

output=$(run_eval "${COLL}.getIndexes()")
assert_contains "$output" "_id_" "default _id index still exists after dropIndexes"
assert_not_contains "$output" "email_1" "email index removed after dropIndexes"

teardown_test_db

print_summary
exit $?
