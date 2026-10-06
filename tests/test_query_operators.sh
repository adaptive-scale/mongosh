#!/bin/bash
# Tests for query operators: comparison, logical, element, regex, array.
# Inspired by MongoDB jstests/core/query/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "Query Operators Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.query_ops_test"

setup_test_db

# Seed data
run_eval "${COLL}.insertMany([
    {name: 'a', val: 10, active: true},
    {name: 'b', val: 20, active: true, opt: 'yes'},
    {name: 'c', val: 30, active: false},
    {name: 'd', val: 40, active: true, opt: 'no'},
    {name: 'e', val: 50, active: false}
])" > /dev/null

# ──────────────────────────────────────────────
print_group "\$gt (greater than)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$gt: 30}}).sort({val: 1}).toArray()")
assert_contains "$output" "'d'" "\$gt: returns d (val=40)"
assert_contains "$output" "'e'" "\$gt: returns e (val=50)"
assert_not_contains "$output" "'c'" "\$gt: excludes c (val=30)"

# ──────────────────────────────────────────────
print_group "\$gte (greater or equal)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$gte: 30}}).sort({val: 1}).toArray()")
assert_contains "$output" "'c'" "\$gte: includes c (val=30)"
assert_contains "$output" "'d'" "\$gte: includes d (val=40)"

# ──────────────────────────────────────────────
print_group "\$lt (less than)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$lt: 20}}).toArray()")
assert_contains "$output" "'a'" "\$lt: returns a (val=10)"
assert_not_contains "$output" "'b'" "\$lt: excludes b (val=20)"

# ──────────────────────────────────────────────
print_group "\$lte (less or equal)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$lte: 20}}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$lte: includes a (val=10)"
assert_contains "$output" "'b'" "\$lte: includes b (val=20)"

# ──────────────────────────────────────────────
print_group "\$ne (not equal)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$ne: 20}}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$ne: includes a (val!=20)"
assert_not_contains "$output" "'b'" "\$ne: excludes b (val=20)"
assert_contains "$output" "'c'" "\$ne: includes c (val!=20)"

# ──────────────────────────────────────────────
print_group "\$in"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$in: [10, 30, 50]}}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$in: includes a (val=10)"
assert_contains "$output" "'c'" "\$in: includes c (val=30)"
assert_contains "$output" "'e'" "\$in: includes e (val=50)"
assert_not_contains "$output" "'b'" "\$in: excludes b (val=20)"

# ──────────────────────────────────────────────
print_group "\$nin"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$nin: [10, 30, 50]}}).sort({val: 1}).toArray()")
assert_contains "$output" "'b'" "\$nin: includes b (val=20)"
assert_contains "$output" "'d'" "\$nin: includes d (val=40)"
assert_not_contains "$output" "'a'" "\$nin: excludes a (val=10)"

# ──────────────────────────────────────────────
print_group "\$and (implicit via multiple conditions)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$gt: 10, \$lt: 40}}).sort({val: 1}).toArray()")
assert_contains "$output" "'b'" "implicit \$and: includes b (20)"
assert_contains "$output" "'c'" "implicit \$and: includes c (30)"
assert_not_contains "$output" "'a'" "implicit \$and: excludes a (10)"
assert_not_contains "$output" "'d'" "implicit \$and: excludes d (40)"

# ──────────────────────────────────────────────
print_group "\$and (explicit)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({\$and: [{val: {\$gte: 20}}, {active: true}]}).sort({val: 1}).toArray()")
assert_contains "$output" "'b'" "explicit \$and: includes b (val=20, active=true)"
assert_contains "$output" "'d'" "explicit \$and: includes d (val=40, active=true)"
assert_not_contains "$output" "'c'" "explicit \$and: excludes c (active=false)"

# ──────────────────────────────────────────────
print_group "\$or"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({\$or: [{val: 10}, {val: 50}]}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$or: includes a (val=10)"
assert_contains "$output" "'e'" "\$or: includes e (val=50)"
assert_not_contains "$output" "'b'" "\$or: excludes b"

# ──────────────────────────────────────────────
print_group "\$not"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({val: {\$not: {\$gt: 30}}}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$not: includes a (val=10, not > 30)"
assert_contains "$output" "'b'" "\$not: includes b (val=20, not > 30)"
assert_contains "$output" "'c'" "\$not: includes c (val=30, not > 30)"
assert_not_contains "$output" "'d'" "\$not: excludes d (val=40, > 30)"

# ──────────────────────────────────────────────
print_group "\$exists"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({opt: {\$exists: true}}).sort({val: 1}).toArray()")
assert_contains "$output" "'b'" "\$exists true: includes b (has opt)"
assert_contains "$output" "'d'" "\$exists true: includes d (has opt)"
assert_not_contains "$output" "'a'" "\$exists true: excludes a (no opt)"

output=$(run_eval "${COLL}.find({opt: {\$exists: false}}).sort({val: 1}).toArray()")
assert_contains "$output" "'a'" "\$exists false: includes a (no opt field)"
assert_not_contains "$output" "'b'" "\$exists false: excludes b (has opt)"

# ──────────────────────────────────────────────
print_group "\$regex"
# ──────────────────────────────────────────────
run_eval "${DB}.regex_test.insertMany([
    {label: 'Alpha'},
    {label: 'Bravo'},
    {label: 'AlphaNumeric'},
    {label: 'charlie'}
])" > /dev/null

output=$(run_eval "${DB}.regex_test.find({label: {\$regex: '^Alpha'}}).toArray()")
assert_contains "$output" "Alpha" "\$regex: matches Alpha prefix"
assert_contains "$output" "AlphaNumeric" "\$regex: matches AlphaNumeric"
assert_not_contains "$output" "Bravo" "\$regex: excludes Bravo"

# ──────────────────────────────────────────────
print_group "\$elemMatch on arrays"
# ──────────────────────────────────────────────
run_eval "${DB}.elemmatch_test.insertMany([
    {nums: [1, 5, 10]},
    {nums: [2, 3, 4]},
    {nums: [20, 30, 40]}
])" > /dev/null

# _id is projected away: a generated ObjectId can contain any digits.
output=$(run_eval "${DB}.elemmatch_test.find({nums: {\$elemMatch: {\$gt: 3, \$lt: 8}}}, {_id: 0}).toArray()")
assert_contains "$output" "nums: \[ 1, 5, 10 \]" "\$elemMatch: matches array with element 5 (3 < 5 < 8)"
assert_not_contains "$output" "20, 30, 40" "\$elemMatch: excludes array [20,30,40]"

# ──────────────────────────────────────────────
print_group "Dot notation nested query"
# ──────────────────────────────────────────────
run_eval "${DB}.nested_test.insertMany([
    {addr: {city: 'NYC', zip: '10001'}},
    {addr: {city: 'LA', zip: '90001'}},
    {addr: {city: 'NYC', zip: '10002'}}
])" > /dev/null

output=$(run_eval "${DB}.nested_test.find({'addr.city': 'NYC'}).toArray()")
assert_contains "$output" "10001" "dot notation: finds first NYC doc"
assert_contains "$output" "10002" "dot notation: finds second NYC doc"
assert_not_contains "$output" "90001" "dot notation: excludes LA doc"

# ──────────────────────────────────────────────
print_group "Array field query"
# ──────────────────────────────────────────────
run_eval "${DB}.array_query_test.insertMany([
    {tags: ['red', 'blue']},
    {tags: ['green', 'yellow']},
    {tags: ['red', 'green']}
])" > /dev/null

output=$(run_eval "${DB}.array_query_test.find({tags: 'red'}).toArray()")
assert_contains "$output" "blue" "array query: finds doc with [red, blue]"
assert_contains "$output" "green" "array query: finds doc with [red, green]"
assert_not_contains "$output" "yellow" "array query: excludes doc without red"

# ──────────────────────────────────────────────
print_group "Null value query"
# ──────────────────────────────────────────────
run_eval "${DB}.null_test.insertMany([
    {x: null, label: 'null_val'},
    {x: 1, label: 'has_val'},
    {label: 'no_x_field'}
])" > /dev/null

output=$(run_eval "${DB}.null_test.find({x: null}).toArray()")
assert_contains "$output" "null_val" "null query: matches doc where x is null"

# ──────────────────────────────────────────────
print_group "distinct with filter"
# ──────────────────────────────────────────────
run_eval "${DB}.distinct_filter_test.insertMany([
    {color: 'red', active: true},
    {color: 'blue', active: true},
    {color: 'red', active: false},
    {color: 'green', active: false}
])" > /dev/null

output=$(run_eval "${DB}.distinct_filter_test.distinct('color', {active: true})")
assert_contains "$output" "red" "distinct with filter: includes red (active)"
assert_contains "$output" "blue" "distinct with filter: includes blue (active)"
assert_not_contains "$output" "green" "distinct with filter: excludes green (inactive)"

teardown_test_db

print_summary
exit $?
