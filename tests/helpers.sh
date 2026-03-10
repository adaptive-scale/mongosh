#!/bin/bash
# Test helpers for go-mongosh shell tests

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

# Binary and connection settings
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONGOSH="${SCRIPT_DIR}/../mongosh"
MONGO_URI="REDACTED_URI"
MONGO_USER="admin"
MONGO_PASS="REDACTED_PASS"
CONN_ARGS="-uri ${MONGO_URI} -u ${MONGO_USER} -p ${MONGO_PASS}"

# Test database used for all tests (cleaned up at end)
TEST_DB="go_mongosh_test_db"

# Run a mongosh eval command and capture output
# Usage: run_eval "js expression"
run_eval() {
    local expr="$1"
    ${MONGOSH} ${CONN_ARGS} -quiet -eval "$expr" 2>&1
}

# Assert that output contains expected string
# Usage: assert_contains "$output" "expected" "test description"
assert_contains() {
    local output="$1"
    local expected="$2"
    local description="$3"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
    if echo "$output" | grep -q "$expected"; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "  ${GREEN}PASS${NC} $description"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "  ${RED}FAIL${NC} $description"
        echo -e "       Expected output to contain: ${YELLOW}${expected}${NC}"
        echo -e "       Got: ${YELLOW}${output}${NC}"
    fi
}

# Assert that output does NOT contain a string
# Usage: assert_not_contains "$output" "unexpected" "test description"
assert_not_contains() {
    local output="$1"
    local unexpected="$2"
    local description="$3"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
    if echo "$output" | grep -q "$unexpected"; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "  ${RED}FAIL${NC} $description"
        echo -e "       Output should NOT contain: ${YELLOW}${unexpected}${NC}"
        echo -e "       Got: ${YELLOW}${output}${NC}"
    else
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "  ${GREEN}PASS${NC} $description"
    fi
}

# Assert that command exits with 0
# Usage: assert_success "$output" "$exit_code" "test description"
assert_exit_success() {
    local exit_code="$1"
    local description="$2"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
    if [ "$exit_code" -eq 0 ]; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "  ${GREEN}PASS${NC} $description"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "  ${RED}FAIL${NC} $description (exit code: $exit_code)"
    fi
}

# Assert that command exits with non-zero
assert_exit_failure() {
    local exit_code="$1"
    local description="$2"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
    if [ "$exit_code" -ne 0 ]; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "  ${GREEN}PASS${NC} $description"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "  ${RED}FAIL${NC} $description (expected non-zero exit code)"
    fi
}

# Assert exact match
assert_equals() {
    local actual="$1"
    local expected="$2"
    local description="$3"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
    if [ "$actual" = "$expected" ]; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "  ${GREEN}PASS${NC} $description"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "  ${RED}FAIL${NC} $description"
        echo -e "       Expected: ${YELLOW}${expected}${NC}"
        echo -e "       Got:      ${YELLOW}${actual}${NC}"
    fi
}

# Print test suite header
print_header() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Print test group
print_group() {
    echo ""
    echo -e "  ${YELLOW}▸ $1${NC}"
}

# Print summary and return exit code
print_summary() {
    echo ""
    echo -e "${CYAN}───────────────────────────────────────────────────${NC}"
    echo -e "  Total: ${TESTS_TOTAL}  ${GREEN}Passed: ${TESTS_PASSED}${NC}  ${RED}Failed: ${TESTS_FAILED}${NC}"
    echo -e "${CYAN}───────────────────────────────────────────────────${NC}"
    echo ""
    return $TESTS_FAILED
}

# Setup: drop test database to start clean
setup_test_db() {
    run_eval "db.getSiblingDB('${TEST_DB}').dropDatabase()" > /dev/null 2>&1
}

# Teardown: drop test database
teardown_test_db() {
    run_eval "db.getSiblingDB('${TEST_DB}').dropDatabase()" > /dev/null 2>&1
}
