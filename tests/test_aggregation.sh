#!/bin/bash
# Tests for aggregation pipeline operations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Aggregation Pipeline Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.agg_test"

setup_test_db

# Seed data
run_eval "${COLL}.insertMany([
    {dept: 'engineering', name: 'Alice', salary: 120000},
    {dept: 'engineering', name: 'Bob', salary: 110000},
    {dept: 'engineering', name: 'Charlie', salary: 130000},
    {dept: 'marketing', name: 'Diana', salary: 95000},
    {dept: 'marketing', name: 'Eve', salary: 105000},
    {dept: 'sales', name: 'Frank', salary: 85000},
    {dept: 'sales', name: 'Grace', salary: 90000},
    {dept: 'sales', name: 'Hank', salary: 80000}
])" > /dev/null

# ──────────────────────────────────────────────
print_group "\$match stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([{\\\$match: {dept: 'engineering'}}]).toArray()")
assert_contains "$output" "Alice" "match returns Alice (engineering)"
assert_contains "$output" "Bob" "match returns Bob (engineering)"
assert_not_contains "$output" "Diana" "match excludes Diana (marketing)"

# ──────────────────────────────────────────────
print_group "\$group stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([
    {\\\$group: {_id: '\\\$dept', total: {\\\$sum: '\\\$salary'}, count: {\\\$sum: 1}}}
]).toArray()")
assert_contains "$output" "engineering" "group by dept shows engineering"
assert_contains "$output" "marketing" "group by dept shows marketing"
assert_contains "$output" "sales" "group by dept shows sales"

# ──────────────────────────────────────────────
print_group "\$sort stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([
    {\\\$sort: {salary: -1}},
    {\\\$limit: 1}
]).toArray()")
assert_contains "$output" "Charlie" "sort desc + limit 1 returns highest salary (Charlie)"

# ──────────────────────────────────────────────
print_group "\$project stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([
    {\\\$match: {name: 'Alice'}},
    {\\\$project: {name: 1, dept: 1, _id: 0}}
]).toArray()")
assert_contains "$output" "Alice" "project includes name"
assert_contains "$output" "engineering" "project includes dept"

# ──────────────────────────────────────────────
print_group "Multi-stage pipeline"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([
    {\\\$match: {salary: {\\\$gte: 100000}}},
    {\\\$group: {_id: '\\\$dept', avgSalary: {\\\$avg: '\\\$salary'}}},
    {\\\$sort: {avgSalary: -1}}
]).toArray()")
assert_contains "$output" "engineering" "multi-stage pipeline returns engineering dept"

# ──────────────────────────────────────────────
print_group "\$count stage"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.aggregate([
    {\\\$match: {dept: 'sales'}},
    {\\\$count: 'salesCount'}
]).toArray()")
assert_contains "$output" "3" "count stage shows 3 sales employees"

# ──────────────────────────────────────────────
print_group "\$unwind stage"
# ──────────────────────────────────────────────
# Insert a doc with an array for unwind test
run_eval "${DB}.agg_unwind.drop()" > /dev/null
run_eval "${DB}.agg_unwind.insertOne({name: 'TestUser', tags: ['a', 'b', 'c']})" > /dev/null
output=$(run_eval "${DB}.agg_unwind.aggregate([{\\\$unwind: '\\\$tags'}]).toArray()")
assert_contains "$output" "\"a\"" "unwind expands array element a"
assert_contains "$output" "\"b\"" "unwind expands array element b"
assert_contains "$output" "\"c\"" "unwind expands array element c"

teardown_test_db

print_summary
exit $?
