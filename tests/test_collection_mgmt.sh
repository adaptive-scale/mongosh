#!/bin/bash
# Tests for collection management: drop, renameCollection, stats, validate,
# isCapped, estimatedDocumentCount, createIndexes (batch), getCollection,
# getName, toString, capped collection creation.
# Inspired by MongoDB jstests/core/ddl/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Collection Management Tests"

DB="db.getSiblingDB('${TEST_DB}')"

setup_test_db

# ──────────────────────────────────────────────
print_group "collection drop"
# ──────────────────────────────────────────────
run_eval "${DB}.drop_me.insertOne({x: 1})" > /dev/null
output=$(run_eval "${DB}.drop_me.drop()")
assert_contains "$output" "true" "drop() returns true"

output=$(run_eval "${DB}.getCollectionNames()")
assert_not_contains "$output" "drop_me" "dropped collection no longer in list"

# ──────────────────────────────────────────────
print_group "renameCollection"
# ──────────────────────────────────────────────
run_eval "${DB}.old_coll.insertOne({msg: 'hello'})" > /dev/null
output=$(run_eval "${DB}.old_coll.renameCollection('new_coll')")
assert_contains "$output" "ok" "renameCollection returns ok"

output=$(run_eval "${DB}.getCollectionNames()")
assert_not_contains "$output" "old_coll" "old collection name gone after rename"
assert_contains "$output" "new_coll" "new collection name appears after rename"

output=$(run_eval "${DB}.new_coll.findOne({msg: 'hello'}).msg")
assert_contains "$output" "hello" "data preserved after rename"

# ──────────────────────────────────────────────
print_group "collection stats"
# ──────────────────────────────────────────────
run_eval "${DB}.stats_test.insertMany([{a:1},{a:2},{a:3}])" > /dev/null
output=$(run_eval "${DB}.stats_test.stats()")
assert_contains "$output" "ns" "stats() returns namespace (ns)"
assert_contains "$output" "count\|size\|storageSize" "stats() returns size info"

# ──────────────────────────────────────────────
print_group "collection validate"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.stats_test.validate()")
assert_contains "$output" "valid\|ok" "validate() returns validity info"

# ──────────────────────────────────────────────
print_group "isCapped on regular collection"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.stats_test.isCapped()")
assert_contains "$output" "false" "regular collection is not capped"

# ──────────────────────────────────────────────
print_group "createCollection with capped options"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.createCollection('capped_test', {capped: true, size: 4096, max: 100})")
assert_contains "$output" "ok" "createCollection capped returns ok"

# ──────────────────────────────────────────────
print_group "isCapped on capped collection"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.capped_test.isCapped()")
assert_contains "$output" "true" "capped collection reports isCapped true"

# ──────────────────────────────────────────────
print_group "estimatedDocumentCount"
# ──────────────────────────────────────────────
run_eval "${DB}.est_count_test.insertMany([{x:1},{x:2},{x:3},{x:4},{x:5}])" > /dev/null
output=$(run_eval "${DB}.est_count_test.estimatedDocumentCount()")
assert_contains "$output" "5" "estimatedDocumentCount returns 5"

# ──────────────────────────────────────────────
print_group "createIndexes (batch)"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.idx_batch_test.insertOne({a:1, b:2, c:3})" > /dev/null; run_eval "${DB}.idx_batch_test.createIndexes([{a: 1}, {b: 1}], {unique: true})")
assert_contains "$output" "a_1" "batch createIndexes returns first index name"
assert_contains "$output" "b_1" "batch createIndexes returns second index name"

# ──────────────────────────────────────────────
print_group "getCollection"
# ──────────────────────────────────────────────
run_eval "${DB}.getCollection('get_coll_test').insertOne({via: 'getCollection'})" > /dev/null
output=$(run_eval "${DB}.getCollection('get_coll_test').findOne({via: 'getCollection'}).via")
assert_contains "$output" "getCollection" "getCollection returns usable collection"

# ──────────────────────────────────────────────
print_group "getName and toString"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.stats_test.getName()")
assert_contains "$output" "stats_test" "getName returns collection name"

output=$(run_eval "${DB}.stats_test.getFullName()")
assert_equals "$output" "${TEST_DB}.stats_test" "getFullName returns database.collection"

# Evaluating a collection prints its namespace.
output=$(run_eval "${DB}.stats_test")
assert_equals "$output" "${TEST_DB}.stats_test" "a collection prints as its namespace"

teardown_test_db

print_summary
exit $?
