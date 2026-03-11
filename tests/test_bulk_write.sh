#!/bin/bash
# Tests for bulkWrite operations with all 6 operation types.
# Inspired by MongoDB jstests/core/write/bulk/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Bulk Write Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.bulk_test"

setup_test_db

# ──────────────────────────────────────────────
print_group "bulkWrite with insertOne operations"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {insertOne: {document: {name: 'Alice', val: 1}}},
    {insertOne: {document: {name: 'Bob', val: 2}}},
    {insertOne: {document: {name: 'Charlie', val: 3}}}
])")
assert_contains "$output" "acknowledged" "bulkWrite insertOne returns acknowledged"
assert_contains "$output" "insertedCount" "bulkWrite insertOne returns insertedCount"
assert_contains "$output" "3" "bulkWrite insertedCount is 3"

# ──────────────────────────────────────────────
print_group "bulkWrite with updateOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {updateOne: {filter: {name: 'Alice'}, update: {\\\$set: {val: 10}}}}
])")
assert_contains "$output" "matchedCount" "bulkWrite updateOne returns matchedCount"
assert_contains "$output" "modifiedCount" "bulkWrite updateOne returns modifiedCount"

# Verify update
output=$(run_eval "${COLL}.findOne({name: 'Alice'}).val")
assert_contains "$output" "10" "bulkWrite updateOne correctly updated value"

# ──────────────────────────────────────────────
print_group "bulkWrite with updateMany"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {updateMany: {filter: {}, update: {\\\$set: {bulk_updated: true}}}}
])")
assert_contains "$output" "matchedCount" "bulkWrite updateMany returns matchedCount"
assert_contains "$output" "modifiedCount" "bulkWrite updateMany returns modifiedCount"

output=$(run_eval "${COLL}.countDocuments({bulk_updated: true})")
assert_contains "$output" "3" "bulkWrite updateMany affected all 3 documents"

# ──────────────────────────────────────────────
print_group "bulkWrite with replaceOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {replaceOne: {filter: {name: 'Charlie'}, replacement: {name: 'Charlie', val: 99, replaced: true}}}
])")
assert_contains "$output" "matchedCount" "bulkWrite replaceOne returns matchedCount"

output=$(run_eval "${COLL}.findOne({name: 'Charlie'}).val")
assert_contains "$output" "99" "bulkWrite replaceOne correctly replaced document"

# ──────────────────────────────────────────────
print_group "bulkWrite with deleteOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {deleteOne: {filter: {name: 'Bob'}}}
])")
assert_contains "$output" "deletedCount" "bulkWrite deleteOne returns deletedCount"

output=$(run_eval "${COLL}.countDocuments({})")
assert_contains "$output" "2" "bulkWrite deleteOne reduced count to 2"

# ──────────────────────────────────────────────
print_group "bulkWrite with deleteMany"
# ──────────────────────────────────────────────
# Add extra docs first
run_eval "${COLL}.insertMany([{name:'x', tmp:true}, {name:'y', tmp:true}])" > /dev/null
output=$(run_eval "${COLL}.bulkWrite([
    {deleteMany: {filter: {tmp: true}}}
])")
assert_contains "$output" "deletedCount" "bulkWrite deleteMany returns deletedCount"

output=$(run_eval "${COLL}.countDocuments({tmp: true})")
assert_contains "$output" "0" "bulkWrite deleteMany removed all tmp documents"

# ──────────────────────────────────────────────
print_group "bulkWrite mixed operations"
# ──────────────────────────────────────────────
run_eval "${COLL}.deleteMany({})" > /dev/null
run_eval "${COLL}.insertMany([{name:'A', v:1}, {name:'B', v:2}, {name:'C', v:3}])" > /dev/null

output=$(run_eval "${COLL}.bulkWrite([
    {insertOne: {document: {name: 'D', v: 4}}},
    {updateOne: {filter: {name: 'A'}, update: {\\\$set: {v: 10}}}},
    {deleteOne: {filter: {name: 'C'}}}
])")
assert_contains "$output" "acknowledged" "mixed bulkWrite returns acknowledged"
assert_contains "$output" "insertedCount" "mixed bulkWrite has insertedCount"
assert_contains "$output" "matchedCount" "mixed bulkWrite has matchedCount"
assert_contains "$output" "deletedCount" "mixed bulkWrite has deletedCount"

# Verify final state
output=$(run_eval "${COLL}.countDocuments({})")
assert_contains "$output" "3" "mixed bulkWrite: 3 started + 1 insert - 1 delete = 3"

output=$(run_eval "${COLL}.findOne({name: 'A'}).v")
assert_contains "$output" "10" "mixed bulkWrite: update took effect"

# ──────────────────────────────────────────────
print_group "bulkWrite with upsert"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.bulkWrite([
    {updateOne: {filter: {name: 'NewDoc'}, update: {\\\$set: {name: 'NewDoc', v: 999}}, upsert: true}}
])")
assert_contains "$output" "upsertedCount" "bulkWrite upsert returns upsertedCount"

output=$(run_eval "${COLL}.findOne({name: 'NewDoc'}).v")
assert_contains "$output" "999" "bulkWrite upsert created document with correct value"

teardown_test_db

print_summary
exit $?
