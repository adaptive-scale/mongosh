#!/bin/bash
# Tests for update operators: $set, $unset, $inc, $push, $pull, $addToSet,
# $rename, $min, $max, $mul, dot notation, $each, multiple operators.
# Inspired by MongoDB jstests/core/write/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Update Operators Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.update_ops_test"

setup_test_db

# Seed a base document
run_eval "${COLL}.insertOne({
    name: 'TestDoc',
    score: 100,
    level: 5,
    tags: ['a', 'b', 'c'],
    addr: {city: 'NYC', zip: '10001'},
    old_field: 'to_rename'
})" > /dev/null

# ──────────────────────────────────────────────
print_group "\$set"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {score: 200}})")
assert_contains "$output" "modifiedCount" "\$set: returns modifiedCount"

output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "200" "\$set: score updated to 200"

# ──────────────────────────────────────────────
print_group "\$unset"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$unset: {old_field: ''}})")
assert_contains "$output" "modifiedCount" "\$unset: returns modifiedCount"

output=$(run_eval "${COLL}.findOne({name: 'TestDoc'})")
assert_not_contains "$output" "old_field" "\$unset: field removed from document"

# ──────────────────────────────────────────────
print_group "\$inc (positive)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$inc: {score: 50}})")
assert_contains "$output" "modifiedCount" "\$inc: returns modifiedCount"

output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "250" "\$inc: score incremented from 200 to 250"

# ──────────────────────────────────────────────
print_group "\$inc (negative / decrement)"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$inc: {score: -100}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "150" "\$inc negative: score decremented from 250 to 150"

# ──────────────────────────────────────────────
print_group "\$push"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$push: {tags: 'd'}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).tags")
assert_contains "$output" "d" "\$push: 'd' added to tags array"

# ──────────────────────────────────────────────
print_group "\$pull"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$pull: {tags: 'b'}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).tags")
assert_not_contains "$output" "'b'" "\$pull: 'b' removed from tags array"
assert_contains "$output" "a" "\$pull: other elements preserved"

# ──────────────────────────────────────────────
print_group "\$addToSet"
# ──────────────────────────────────────────────
# Add new element
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$addToSet: {tags: 'z'}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).tags")
assert_contains "$output" "z" "\$addToSet: 'z' added to tags"

# Add duplicate - should not duplicate
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$addToSet: {tags: 'z'}})" > /dev/null
output=$(run_eval "var doc = ${COLL}.findOne({name: 'TestDoc'}); var count = 0; doc.tags.forEach(function(t) { if (t === 'z') count++ }); print(count)")
assert_contains "$output" "1" "\$addToSet: duplicate 'z' not added (count=1)"

# ──────────────────────────────────────────────
print_group "\$rename"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {temp_field: 'value'}})" > /dev/null
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$rename: {temp_field: 'renamed_field'}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'})")
assert_contains "$output" "renamed_field" "\$rename: new field name exists"
assert_not_contains "$output" "temp_field" "\$rename: old field name removed"

# ──────────────────────────────────────────────
print_group "\$min"
# ──────────────────────────────────────────────
# Current score is 150, $min with 100 should update
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$min: {score: 100}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "100" "\$min: score reduced to 100 (was 150)"

# $min with 200 should NOT update (200 > 100)
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$min: {score: 200}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "100" "\$min: score stays 100 (200 > current)"

# ──────────────────────────────────────────────
print_group "\$max"
# ──────────────────────────────────────────────
# Current score is 100, $max with 500 should update
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$max: {score: 500}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "500" "\$max: score increased to 500 (was 100)"

# $max with 50 should NOT update (50 < 500)
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$max: {score: 50}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "500" "\$max: score stays 500 (50 < current)"

# ──────────────────────────────────────────────
print_group "\$mul"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {score: 10}})" > /dev/null
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$mul: {score: 3}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).score")
assert_contains "$output" "30" "\$mul: score multiplied from 10 to 30"

# ──────────────────────────────────────────────
print_group "\$set with dot notation (nested field)"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {'addr.zip': '10002'}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).addr.zip")
assert_contains "$output" "10002" "\$set dot notation: nested zip updated"

output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).addr.city")
assert_contains "$output" "NYC" "\$set dot notation: sibling field preserved"

# ──────────────────────────────────────────────
print_group "\$push with \$each"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$push: {tags: {\$each: ['x', 'y']}}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).tags")
assert_contains "$output" "x" "\$push \$each: 'x' added"
assert_contains "$output" "y" "\$push \$each: 'y' added"

# ──────────────────────────────────────────────
print_group "Multiple operators in one update"
# ──────────────────────────────────────────────
run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {status: 'active'}, \$inc: {level: 2}})" > /dev/null
output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).status")
assert_contains "$output" "active" "multi-operator: \$set applied"

output=$(run_eval "${COLL}.findOne({name: 'TestDoc'}).level")
assert_contains "$output" "7" "multi-operator: \$inc applied (5+2=7)"

# ──────────────────────────────────────────────
print_group "matchedCount vs modifiedCount (no-op update)"
# ──────────────────────────────────────────────
# Set score to 30 (already 30), should match but not modify
output=$(run_eval "${COLL}.updateOne({name: 'TestDoc'}, {\$set: {score: 30}})")
assert_contains "$output" "matchedCount" "no-op update: has matchedCount"
assert_contains "$output" "modifiedCount" "no-op update: has modifiedCount"
# The modifiedCount should be 0 since value unchanged
output=$(run_eval "var r = ${COLL}.updateOne({name: 'TestDoc'}, {\$set: {score: 30}}); print(r.modifiedCount)")
assert_contains "$output" "0" "no-op update: modifiedCount is 0"

teardown_test_db

print_summary
exit $?
