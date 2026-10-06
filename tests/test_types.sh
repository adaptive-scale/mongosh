#!/bin/bash
# Tests for BSON type constructors and conversions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "BSON Types Tests"

DB="db.getSiblingDB('${TEST_DB}')"
COLL="${DB}.types_test"

setup_test_db

# ──────────────────────────────────────────────
print_group "ObjectId"
# ──────────────────────────────────────────────
output=$(run_eval "ObjectId()")
assert_contains "$output" "ObjectId" "ObjectId() creates an ObjectId"

output=$(run_eval "ObjectId('507f1f77bcf86cd799439011')")
assert_contains "$output" "507f1f77bcf86cd799439011" "ObjectId with specific value"

# ──────────────────────────────────────────────
print_group "NumberLong"
# ──────────────────────────────────────────────
output=$(run_eval "NumberLong(9999999999)")
assert_contains "$output" "9999999999" "NumberLong stores large number"

# Insert and retrieve to verify persistence
run_eval "${COLL}.insertOne({type: 'long', value: NumberLong(1234567890123)})" > /dev/null
output=$(run_eval "${COLL}.findOne({type: 'long'})")
assert_contains "$output" "1234567890123" "NumberLong persists correctly in MongoDB"

# ──────────────────────────────────────────────
print_group "NumberInt"
# ──────────────────────────────────────────────
output=$(run_eval "NumberInt(42)")
assert_contains "$output" "42" "NumberInt returns integer value"

# ──────────────────────────────────────────────
print_group "NumberDecimal"
# ──────────────────────────────────────────────
output=$(run_eval "NumberDecimal('3.14159')")
assert_contains "$output" "3.14159" "NumberDecimal stores decimal value"

# ──────────────────────────────────────────────
print_group "ISODate"
# ──────────────────────────────────────────────
output=$(run_eval "ISODate('2024-01-15T10:30:00Z')")
assert_contains "$output" "2024-01-15" "ISODate parses date string"

output=$(run_eval "ISODate()")
exit_code=$?
assert_exit_success "$exit_code" "ISODate() without args succeeds (current date)"

# ──────────────────────────────────────────────
print_group "UUID"
# ──────────────────────────────────────────────
output=$(run_eval "UUID()")
exit_code=$?
assert_exit_success "$exit_code" "UUID() generates a UUID"

# ──────────────────────────────────────────────
print_group "Timestamp"
# ──────────────────────────────────────────────
output=$(run_eval "Timestamp(1700000000, 1)")
assert_contains "$output" "Timestamp" "Timestamp constructor works"

# ──────────────────────────────────────────────
print_group "MinKey / MaxKey"
# ──────────────────────────────────────────────
output=$(run_eval "MinKey()")
assert_equals "$output" "MinKey()" "MinKey() creates a MinKey"

output=$(run_eval "MaxKey()")
assert_equals "$output" "MaxKey()" "MaxKey() creates a MaxKey"

# ──────────────────────────────────────────────
print_group "Mixed types in document"
# ──────────────────────────────────────────────
run_eval "${COLL}.insertOne({
    type: 'mixed',
    oid: ObjectId(),
    num_long: NumberLong(999),
    num_int: NumberInt(10),
    num_dec: NumberDecimal('2.718'),
    date: ISODate('2024-06-15T00:00:00Z')
})" > /dev/null

output=$(run_eval "${COLL}.findOne({type: 'mixed'})")
assert_contains "$output" "ObjectId" "mixed doc has ObjectId"
assert_contains "$output" "2024-06-15" "mixed doc has ISODate"

# ──────────────────────────────────────────────
print_group "JSON conversion"
# ──────────────────────────────────────────────
output=$(run_eval "EJSON.stringify({a: 1, b: 'hello'})")
assert_contains "$output" '"a":1' "EJSON.stringify outputs key a"
assert_contains "$output" '"b":"hello"' "EJSON.stringify outputs value hello"

teardown_test_db

print_summary
exit $?
