#!/bin/bash
# Tests for findOneAndUpdate, findOneAndReplace, findOneAndDelete with full options,
# and the raw findAndModify command.
# Inspired by MongoDB jstests/core/query/ find-and-modify patterns.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "FindAndModify Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.fam_test"

setup_test_db

# Seed data
run_eval "${COLL}.insertMany([
    {name: 'Alice', score: 10, city: 'NYC'},
    {name: 'Bob', score: 20, city: 'LA'},
    {name: 'Charlie', score: 30, city: 'NYC'},
    {name: 'Diana', score: 15, city: 'LA'},
    {name: 'Eve', score: 25, city: 'Chicago'}
])" > /dev/null

# ──────────────────────────────────────────────
print_group "findOneAndUpdate with returnDocument:'after'"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndUpdate({name: 'Alice'}, {\\\$set: {score: 99}}, {returnDocument: 'after'})")
assert_contains "$output" "99" "returnDocument after: returns updated score 99"
assert_contains "$output" "Alice" "returnDocument after: returns correct document"

# ──────────────────────────────────────────────
print_group "findOneAndUpdate with upsert (no match)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndUpdate({name: 'Zara'}, {\\\$set: {name: 'Zara', score: 50}}, {upsert: true, returnDocument: 'after'})")
assert_contains "$output" "Zara" "upsert creates new document"
assert_contains "$output" "50" "upserted document has correct score"

# Verify it actually exists
output=$(run_eval "${COLL}.findOne({name: 'Zara'}).score")
assert_contains "$output" "50" "upserted document persists in collection"

# ──────────────────────────────────────────────
print_group "findOneAndUpdate with projection"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndUpdate({name: 'Bob'}, {\\\$set: {score: 21}}, {projection: {name: 1, _id: 0}, returnDocument: 'after'})")
assert_contains "$output" "Bob" "projection includes name"
assert_not_contains "$output" "city" "projection excludes city"

# ──────────────────────────────────────────────
print_group "findOneAndUpdate with sort"
# ──────────────────────────────────────────────
# Update the NYC person with the lowest score (Alice=99 after earlier update, Charlie=30)
output=$(run_eval "${COLL}.findOneAndUpdate({city: 'NYC'}, {\\\$set: {tagged: true}}, {sort: {score: 1}, returnDocument: 'after'})")
assert_contains "$output" "Charlie" "sort ascending: updates lowest-scored NYC doc (Charlie=30)"
assert_contains "$output" "tagged" "sort: updated document has new field"

# ──────────────────────────────────────────────
print_group "findOneAndUpdate returns null (no match)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndUpdate({name: 'NonExistent'}, {\\\$set: {x: 1}})")
assert_contains "$output" "null" "no match without upsert returns null"

# ──────────────────────────────────────────────
print_group "findOneAndReplace basic (returns original)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndReplace({name: 'Diana'}, {name: 'Diana', score: 100, city: 'SF'})")
assert_contains "$output" "Diana" "replace returns original document"
assert_contains "$output" "LA" "replace returns original city (LA, not SF)"

# ──────────────────────────────────────────────
print_group "findOneAndReplace with returnDocument:'after'"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndReplace({name: 'Diana'}, {name: 'Diana', score: 200, city: 'Boston'}, {returnDocument: 'after'})")
assert_contains "$output" "Boston" "returnDocument after: returns new city"
assert_contains "$output" "200" "returnDocument after: returns new score"

# ──────────────────────────────────────────────
print_group "findOneAndReplace with upsert"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndReplace({name: 'Frank'}, {name: 'Frank', score: 77, city: 'Denver'}, {upsert: true, returnDocument: 'after'})")
assert_contains "$output" "Frank" "upsert replace creates document"
assert_contains "$output" "Denver" "upserted document has correct city"

# ──────────────────────────────────────────────
print_group "findOneAndDelete with sort"
# ──────────────────────────────────────────────
# Delete the person with the highest score overall
output=$(run_eval "${COLL}.findOneAndDelete({}, {sort: {score: -1}})")
assert_contains "$output" "Diana" "sort descending: deletes highest-scored doc (Diana=200)"

# ──────────────────────────────────────────────
print_group "findOneAndDelete with projection"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndDelete({name: 'Eve'}, {projection: {name: 1, _id: 0}})")
assert_contains "$output" "Eve" "projection includes name in deleted doc"
assert_not_contains "$output" "score" "projection excludes score from deleted doc"

# ──────────────────────────────────────────────
print_group "findAndModify raw command"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findAndModify({query: {name: 'Bob'}, update: {\\\$set: {status: 'done'}}, new: true})")
assert_contains "$output" "value" "findAndModify returns result with value field"
assert_contains "$output" "done" "findAndModify updated document has new status"

teardown_test_db

print_summary
exit $?
