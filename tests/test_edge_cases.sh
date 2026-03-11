#!/bin/bash
# Tests for edge cases and robustness.
# Inspired by MongoDB jstests edge case patterns: null handling,
# empty collections, special characters, nested docs, large batches.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Edge Cases Tests"

DB="db.getSiblingDB('${TEST_DB}')"

setup_test_db

# ──────────────────────────────────────────────
print_group "Special characters in values"
# ──────────────────────────────────────────────
run_eval "${DB}.special_chars.insertOne({company: \"O'Reilly\", desc: 'quotes and stuff'})" > /dev/null
output=$(run_eval "${DB}.special_chars.findOne({company: \"O'Reilly\"}).company")
assert_contains "$output" "O'Reilly" "special chars: single quote preserved"

# ──────────────────────────────────────────────
print_group "Deeply nested document (5 levels)"
# ──────────────────────────────────────────────
run_eval "${DB}.deep_nest.insertOne({a: {b: {c: {d: {e: 'deep_value'}}}}})" > /dev/null
output=$(run_eval "${DB}.deep_nest.findOne({'a.b.c.d.e': 'deep_value'})")
assert_contains "$output" "deep_value" "deep nesting: 5-level dot notation query works"

# ──────────────────────────────────────────────
print_group "Empty string field"
# ──────────────────────────────────────────────
run_eval "${DB}.empty_str.insertOne({name: '', label: 'empty_name'})" > /dev/null
output=$(run_eval "${DB}.empty_str.findOne({label: 'empty_name'}).name")
exit_code=$?
assert_exit_success "$exit_code" "empty string: insert and retrieve succeeds"

# ──────────────────────────────────────────────
print_group "Boolean fields"
# ──────────────────────────────────────────────
run_eval "${DB}.bool_test.insertMany([
    {label: 'yes', active: true, deleted: false},
    {label: 'no', active: false, deleted: true}
])" > /dev/null

output=$(run_eval "${DB}.bool_test.find({active: true}).toArray()")
assert_contains "$output" "yes" "boolean: finds doc where active=true"
assert_not_contains "$output" "\"no\"" "boolean: excludes doc where active=false"

output=$(run_eval "${DB}.bool_test.find({deleted: false}).toArray()")
assert_contains "$output" "yes" "boolean: finds doc where deleted=false"

# ──────────────────────────────────────────────
print_group "find on empty collection"
# ──────────────────────────────────────────────
run_eval "${DB}.createCollection('empty_coll')" > /dev/null
output=$(run_eval "${DB}.empty_coll.find({}).toArray()")
exit_code=$?
assert_exit_success "$exit_code" "find on empty: executes without error"

# ──────────────────────────────────────────────
print_group "findOne on empty collection"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.empty_coll.findOne({})")
assert_contains "$output" "null" "findOne on empty: returns null"

# ──────────────────────────────────────────────
print_group "countDocuments on empty collection"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.empty_coll.countDocuments({})")
assert_contains "$output" "0" "countDocuments on empty: returns 0"

# ──────────────────────────────────────────────
print_group "deleteMany with empty filter (delete all)"
# ──────────────────────────────────────────────
run_eval "${DB}.del_all.insertMany([{x:1},{x:2},{x:3},{x:4},{x:5}])" > /dev/null
output=$(run_eval "${DB}.del_all.deleteMany({})")
assert_contains "$output" "deletedCount" "deleteMany all: returns deletedCount"
assert_contains "$output" "5" "deleteMany all: deleted 5 documents"

output=$(run_eval "${DB}.del_all.countDocuments({})")
assert_contains "$output" "0" "deleteMany all: collection now empty"

# ──────────────────────────────────────────────
print_group "updateOne no match"
# ──────────────────────────────────────────────
run_eval "${DB}.no_match.insertOne({x: 1})" > /dev/null
output=$(run_eval "var r = ${DB}.no_match.updateOne({x: 999}, {\\\$set: {y: 1}}); print(r.matchedCount)")
assert_contains "$output" "0" "updateOne no match: matchedCount is 0"

# ──────────────────────────────────────────────
print_group "Large insertMany (100 documents)"
# ──────────────────────────────────────────────
run_eval "${DB}.large_insert.insertMany(
    Array.from({length: 100}, function(_, i) {
        return {idx: i, data: 'item_' + i}
    })
)" > /dev/null

output=$(run_eval "${DB}.large_insert.countDocuments({})")
assert_contains "$output" "100" "large insertMany: 100 documents inserted"

# ──────────────────────────────────────────────
print_group "Distinct on empty collection"
# ──────────────────────────────────────────────
run_eval "${DB}.createCollection('distinct_empty')" > /dev/null
output=$(run_eval "${DB}.distinct_empty.distinct('field')")
exit_code=$?
assert_exit_success "$exit_code" "distinct on empty: no error"

# ──────────────────────────────────────────────
print_group "Multiple operations in one eval"
# ──────────────────────────────────────────────
output=$(run_eval "
    ${DB}.multi_op.insertOne({step: 1, val: 'initial'});
    ${DB}.multi_op.updateOne({step: 1}, {\\\$set: {val: 'updated'}});
    var doc = ${DB}.multi_op.findOne({step: 1});
    print(doc.val);
")
assert_contains "$output" "updated" "multi-op: sequential insert, update, find works"

# ──────────────────────────────────────────────
print_group "Document with numeric-like field names"
# ──────────────────────────────────────────────
run_eval "${DB}.num_fields.insertOne({'0': 'zero', '1': 'one', label: 'numeric_keys'})" > /dev/null
output=$(run_eval "${DB}.num_fields.findOne({label: 'numeric_keys'})")
assert_contains "$output" "zero" "numeric keys: field '0' preserved"
assert_contains "$output" "one" "numeric keys: field '1' preserved"

# ──────────────────────────────────────────────
print_group "Insert and query with large array field"
# ──────────────────────────────────────────────
run_eval "${DB}.large_arr.insertOne({
    label: 'big_array',
    nums: Array.from({length: 50}, function(_, i) { return i })
})" > /dev/null

output=$(run_eval "${DB}.large_arr.findOne({label: 'big_array'}).nums.length")
assert_contains "$output" "50" "large array: 50-element array preserved"

teardown_test_db

print_summary
exit $?
