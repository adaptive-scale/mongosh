#!/bin/bash
# Tests for advanced cursor methods: projection(), batchSize(), hint(),
# comment(), collation(), itcount(), size(), close(), explain with verbosity.
# Inspired by MongoDB jstests/core/query/ cursor patterns.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Advanced Cursor Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.cursor_adv_test"

setup_test_db

# Seed data: 15 documents
run_eval "${COLL}.insertMany(
    Array.from({length: 15}, function(_, i) {
        return {seq: i + 1, name: 'item_' + (i + 1), val: (i + 1) * 10, category: (i % 3 === 0 ? 'A' : (i % 3 === 1 ? 'B' : 'C'))}
    })
)" > /dev/null

# Create an index for hint tests
run_eval "${COLL}.createIndex({name: 1})" > /dev/null

# ──────────────────────────────────────────────
print_group "projection() chaining"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({seq: 1}).projection({name: 1, _id: 0}).toArray()")
assert_contains "$output" "item_1" "projection chaining: includes name"
assert_not_contains "$output" "val" "projection chaining: excludes val"
assert_not_contains "$output" "seq" "projection chaining: excludes seq"

# ──────────────────────────────────────────────
print_group "batchSize()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).batchSize(5).toArray()")
exit_code=$?
assert_exit_success "$exit_code" "batchSize: query succeeds"
# batchSize affects wire protocol batching, not total results
assert_contains "$output" "item_1" "batchSize: returns first item"
assert_contains "$output" "item_15" "batchSize: returns last item (all results)"

# ──────────────────────────────────────────────
print_group "hint() with index name"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({name: 'item_5'}).hint('name_1').toArray()")
assert_contains "$output" "item_5" "hint by name: returns correct document"

# ──────────────────────────────────────────────
print_group "hint() with index spec"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({name: 'item_10'}).hint({name: 1}).toArray()")
assert_contains "$output" "item_10" "hint by spec: returns correct document"

# ──────────────────────────────────────────────
print_group "comment()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({seq: 3}).comment('test_cursor_comment').toArray()")
assert_contains "$output" "item_3" "comment: query with comment succeeds"

# ──────────────────────────────────────────────
print_group "collation() case-insensitive"
# ──────────────────────────────────────────────
run_eval "${DB}.collation_test.insertMany([
    {word: 'apple'},
    {word: 'Banana'},
    {word: 'cherry'},
    {word: 'Apple'}
])" > /dev/null

output=$(run_eval "${DB}.collation_test.find({}).collation({locale: 'en', strength: 2}).sort({word: 1}).toArray()")
exit_code=$?
assert_exit_success "$exit_code" "collation: case-insensitive sort succeeds"
# With strength:2 (case-insensitive), apple/Apple should be adjacent
assert_contains "$output" "apple" "collation: result contains apple"
assert_contains "$output" "Banana" "collation: result contains Banana"

# ──────────────────────────────────────────────
print_group "itcount()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).itcount()")
assert_contains "$output" "15" "itcount: returns 15 for all documents"

output=$(run_eval "${COLL}.find({category: 'A'}).itcount()")
exit_code=$?
assert_exit_success "$exit_code" "itcount with filter: succeeds"

# ──────────────────────────────────────────────
print_group "size() alias for count()"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).size()")
assert_contains "$output" "15" "size: returns 15 (same as count)"

# ──────────────────────────────────────────────
print_group "close()"
# ──────────────────────────────────────────────
output=$(run_eval "var c = ${COLL}.find({}); c.close(); print('closed_ok')")
assert_contains "$output" "closed_ok" "close: cursor closed without error"

# ──────────────────────────────────────────────
print_group "count with filter in find"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\\\$gt: 100}}).count()")
exit_code=$?
assert_exit_success "$exit_code" "count with filter: executes successfully"

# ──────────────────────────────────────────────
print_group "explain with executionStats verbosity"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({name: 'item_1'}).explain('executionStats')")
assert_contains "$output" "executionStats" "explain executionStats: returns executionStats field"

teardown_test_db

print_summary
exit $?
