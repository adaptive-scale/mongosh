#!/bin/bash
# Tests for user and role management functions.
# Inspired by MongoDB jstests/auth/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

print_header "User & Role Management Tests"

DB="db.getSiblingDB('${TEST_DB}')"

setup_test_db

# Cleanup from any previous failed runs
run_eval "${DB}.dropUser('test_user_gomongosh')" > /dev/null 2>&1 || true
run_eval "${DB}.dropRole('test_role_gomongosh')" > /dev/null 2>&1 || true

# ──────────────────────────────────────────────
print_group "createUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.createUser({user: 'test_user_gomongosh', pwd: 'testPass123', roles: [{role: 'readWrite', db: '${TEST_DB}'}]})")
assert_contains "$output" "ok" "createUser returns ok"

# ──────────────────────────────────────────────
print_group "getUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.getUser('test_user_gomongosh')")
assert_contains "$output" "test_user_gomongosh" "getUser returns user info"

# ──────────────────────────────────────────────
print_group "getUsers"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.getUsers()")
assert_contains "$output" "test_user_gomongosh" "getUsers lists created user"

# ──────────────────────────────────────────────
print_group "updateUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.updateUser('test_user_gomongosh', {roles: [{role: 'read', db: '${TEST_DB}'}]})")
assert_contains "$output" "ok" "updateUser returns ok"

# ──────────────────────────────────────────────
print_group "changeUserPassword"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.changeUserPassword('test_user_gomongosh', 'newPass456')")
assert_contains "$output" "ok" "changeUserPassword returns ok"

# ──────────────────────────────────────────────
print_group "grantRolesToUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.grantRolesToUser('test_user_gomongosh', [{role: 'readWrite', db: '${TEST_DB}'}])")
assert_contains "$output" "ok" "grantRolesToUser returns ok"

# ──────────────────────────────────────────────
print_group "revokeRolesFromUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.revokeRolesFromUser('test_user_gomongosh', [{role: 'readWrite', db: '${TEST_DB}'}])")
assert_contains "$output" "ok" "revokeRolesFromUser returns ok"

# ──────────────────────────────────────────────
print_group "dropUser"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.dropUser('test_user_gomongosh')")
assert_contains "$output" "ok" "dropUser returns ok"

# ──────────────────────────────────────────────
print_group "createRole"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.createRole({role: 'test_role_gomongosh', privileges: [{resource: {db: '${TEST_DB}', collection: ''}, actions: ['find', 'insert']}], roles: []})")
assert_contains "$output" "ok" "createRole returns ok"

# ──────────────────────────────────────────────
print_group "getRole"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.getRole('test_role_gomongosh')")
assert_contains "$output" "test_role_gomongosh" "getRole returns role info"

# ──────────────────────────────────────────────
print_group "getRoles"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.getRoles()")
assert_contains "$output" "test_role_gomongosh" "getRoles lists created role"

# ──────────────────────────────────────────────
print_group "grantRolesToRole"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.grantRolesToRole('test_role_gomongosh', [{role: 'read', db: '${TEST_DB}'}])")
assert_contains "$output" "ok" "grantRolesToRole returns ok"

# ──────────────────────────────────────────────
print_group "revokeRolesFromRole"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.revokeRolesFromRole('test_role_gomongosh', [{role: 'read', db: '${TEST_DB}'}])")
assert_contains "$output" "ok" "revokeRolesFromRole returns ok"

# ──────────────────────────────────────────────
print_group "dropRole"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.dropRole('test_role_gomongosh')")
assert_contains "$output" "ok" "dropRole returns ok"

# ──────────────────────────────────────────────
print_group "db.auth() not supported"
# ──────────────────────────────────────────────
output=$(run_eval "${DB}.auth()" 2>&1 || true)
assert_contains "$output" "not supported" "db.auth() shows not supported message"

teardown_test_db

print_summary
exit $?
