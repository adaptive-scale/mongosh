#!/bin/bash
# Tests for CRUD (Create, Read, Update, Delete) operations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "CRUD Operations Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.crud_test"

setup_test_db

# ──────────────────────────────────────────────
print_group "insertOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.insertOne({name: 'Alice', age: 30, city: 'NYC'})")
assert_contains "$output" "acknowledged" "insertOne returns acknowledged"
assert_contains "$output" "insertedId" "insertOne returns insertedId"

# ──────────────────────────────────────────────
print_group "insertMany"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.insertMany([
    {name: 'Bob', age: 25, city: 'LA'},
    {name: 'Charlie', age: 35, city: 'Chicago'},
    {name: 'Diana', age: 28, city: 'NYC'},
    {name: 'Eve', age: 32, city: 'LA'}
])")
assert_contains "$output" "acknowledged" "insertMany returns acknowledged"
assert_contains "$output" "insertedIds" "insertMany returns insertedIds"

# ──────────────────────────────────────────────
print_group "findOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOne({name: 'Alice'})")
assert_contains "$output" "Alice" "findOne returns matching document"
assert_contains "$output" "age" "findOne result includes all fields"
assert_contains "$output" "30" "findOne result has correct age"

# ──────────────────────────────────────────────
print_group "find (multiple documents)"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({city: 'NYC'}).toArray()")
assert_contains "$output" "Alice" "find returns first NYC match"
assert_contains "$output" "Diana" "find returns second NYC match"

output=$(run_eval "${COLL}.find({}).toArray()")
assert_contains "$output" "Alice" "find all returns Alice"
assert_contains "$output" "Bob" "find all returns Bob"
assert_contains "$output" "Charlie" "find all returns Charlie"

# ──────────────────────────────────────────────
print_group "find with projection"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.find({name: 'Alice'}, {name: 1, _id: 0}).toArray()")
assert_contains "$output" "Alice" "projection includes name"
assert_not_contains "$output" "age" "projection excludes age"

# ──────────────────────────────────────────────
print_group "countDocuments"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.countDocuments({})")
assert_contains "$output" "5" "countDocuments returns 5 for all docs"

output=$(run_eval "${COLL}.countDocuments({city: 'NYC'})")
assert_contains "$output" "2" "countDocuments with filter returns 2"

# ──────────────────────────────────────────────
print_group "updateOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateOne({name: 'Alice'}, {\\\$set: {age: 31}})")
assert_contains "$output" "acknowledged" "updateOne returns acknowledged"
assert_contains "$output" "matchedCount" "updateOne returns matchedCount"

# Verify update took effect
output=$(run_eval "${COLL}.findOne({name: 'Alice'}).age")
assert_contains "$output" "31" "updateOne correctly updated age to 31"

# ──────────────────────────────────────────────
print_group "updateMany"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateMany({city: 'LA'}, {\\\$set: {state: 'California'}})")
assert_contains "$output" "acknowledged" "updateMany returns acknowledged"
assert_contains "$output" "modifiedCount" "updateMany returns modifiedCount"

output=$(run_eval "${COLL}.findOne({name: 'Bob'}).state")
assert_contains "$output" "California" "updateMany correctly set state"

# ──────────────────────────────────────────────
print_group "replaceOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.replaceOne({name: 'Eve'}, {name: 'Eve', age: 33, city: 'SF', replaced: true})")
assert_contains "$output" "acknowledged" "replaceOne returns acknowledged"

output=$(run_eval "${COLL}.findOne({name: 'Eve'}).city")
assert_contains "$output" "SF" "replaceOne correctly replaced document"

# ──────────────────────────────────────────────
print_group "findOneAndUpdate"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndUpdate({name: 'Bob'}, {\\\$set: {age: 26}})")
assert_contains "$output" "Bob" "findOneAndUpdate returns the document"

output=$(run_eval "${COLL}.findOne({name: 'Bob'}).age")
assert_contains "$output" "26" "findOneAndUpdate correctly updated"

# ──────────────────────────────────────────────
print_group "findOneAndDelete"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.findOneAndDelete({name: 'Charlie'})")
assert_contains "$output" "Charlie" "findOneAndDelete returns deleted doc"

output=$(run_eval "${COLL}.countDocuments({})")
assert_contains "$output" "4" "document count reduced after findOneAndDelete"

# ──────────────────────────────────────────────
print_group "deleteOne"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.deleteOne({name: 'Diana'})")
assert_contains "$output" "acknowledged" "deleteOne returns acknowledged"
assert_contains "$output" "deletedCount" "deleteOne returns deletedCount"

output=$(run_eval "${COLL}.countDocuments({})")
assert_contains "$output" "3" "document count reduced after deleteOne"

# ──────────────────────────────────────────────
print_group "deleteMany"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.deleteMany({city: 'SF'})")
assert_contains "$output" "acknowledged" "deleteMany returns acknowledged"

# ──────────────────────────────────────────────
print_group "distinct"
# ──────────────────────────────────────────────
# Re-insert some data for distinct test
run_eval "${COLL}.insertMany([{x:1, color:'red'}, {x:2, color:'blue'}, {x:3, color:'red'}])" > /dev/null
output=$(run_eval "${COLL}.distinct('color')")
assert_contains "$output" "red" "distinct returns red"
assert_contains "$output" "blue" "distinct returns blue"

# ──────────────────────────────────────────────
print_group "Upsert"
# ──────────────────────────────────────────────
output=$(run_eval "${COLL}.updateOne({name: 'Zara'}, {\\\$set: {name: 'Zara', age: 40}}, {upsert: true})")
assert_contains "$output" "acknowledged" "upsert returns acknowledged"

output=$(run_eval "${COLL}.findOne({name: 'Zara'}).age")
assert_contains "$output" "40" "upserted document exists with correct data"

teardown_test_db

print_summary
exit $?
