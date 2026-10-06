#!/bin/bash
# Tests for cursor operations (sort, limit, skip, etc.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Cursor Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.cursor_test"

setup_test_db

# Seed data: 20 documents
run_eval "${COLL}.insertMany(
    Array.from({length: 20}, function(_, i) {
        return {seq: i + 1, name: 'item_' + (i + 1), value: (i + 1) * 10}
    })
)" > /dev/null

# ──────────────────────────────────────────────
print_group "sort"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).sort({seq: 1}).limit(3).toArray()")
assert_contains "$output" "item_1" "sort ascending: first item is item_1"
assert_contains "$output" "item_2" "sort ascending: includes item_2"

output=$(run_eval "${COLL}.find({}).sort({seq: -1}).limit(3).toArray()")
assert_contains "$output" "item_20" "sort descending: first item is item_20"
assert_contains "$output" "item_19" "sort descending: includes item_19"

# ──────────────────────────────────────────────
print_group "limit"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).sort({seq: 1}).limit(2).toArray()")
assert_contains "$output" "item_1" "limit 2: includes item_1"
assert_contains "$output" "item_2" "limit 2: includes item_2"
assert_not_contains "$output" "item_3" "limit 2: excludes item_3"

# ──────────────────────────────────────────────
print_group "skip"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).sort({seq: 1}).skip(18).toArray()")
assert_contains "$output" "item_19" "skip 18: includes item_19"
assert_contains "$output" "item_20" "skip 18: includes item_20"
assert_not_contains "$output" "item_18" "skip 18: excludes item_18"

# ──────────────────────────────────────────────
print_group "skip + limit combined"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).sort({seq: 1}).skip(5).limit(3).toArray()")
assert_contains "$output" "item_6" "skip 5 + limit 3: includes item_6"
assert_contains "$output" "item_7" "skip 5 + limit 3: includes item_7"
assert_contains "$output" "item_8" "skip 5 + limit 3: includes item_8"
assert_not_contains "$output" "item_5" "skip 5 + limit 3: excludes item_5"
assert_not_contains "$output" "item_9" "skip 5 + limit 3: excludes item_9"

# ──────────────────────────────────────────────
print_group "count"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({}).count()")
assert_contains "$output" "20" "count returns 20 for all documents"

output=$(run_eval "${COLL}.find({seq: {\$gt: 15}}).count()")
assert_contains "$output" "5" "count with filter returns 5"

# ──────────────────────────────────────────────
print_group "forEach"
# ──────────────────────────────────────────────
output=$(run_eval "var items = []; ${COLL}.find({seq: {\$lte: 3}}).sort({seq: 1}).forEach(function(d) { items.push(d.name) }); print(items.join(','))")
assert_contains "$output" "item_1,item_2,item_3" "forEach iterates in order"

# ──────────────────────────────────────────────
print_group "map"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({seq: {\$lte: 3}}).sort({seq: 1}).map(function(d) { return d.value })")
assert_contains "$output" "10" "map returns value 10"
assert_contains "$output" "20" "map returns value 20"
assert_contains "$output" "30" "map returns value 30"

# ──────────────────────────────────────────────
print_group "hasNext / next"
# ──────────────────────────────────────────────
output=$(run_eval "var c = ${COLL}.find({seq: 1}); print(c.hasNext())")
assert_contains "$output" "true" "hasNext returns true when docs exist"

# ──────────────────────────────────────────────
print_group "Chained operations"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({value: {\$gte: 100}}).sort({value: -1}).limit(5).skip(1).toArray()")
exit_code=$?
assert_exit_success "$exit_code" "chained sort.limit.skip executes successfully"

# ──────────────────────────────────────────────
print_group "explain"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({seq: 1}).explain()")
assert_contains "$output" "queryPlanner" "explain returns queryPlanner"

teardown_test_db

print_summary
exit $?
