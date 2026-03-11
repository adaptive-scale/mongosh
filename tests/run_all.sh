#!/bin/bash
# Main test runner for go-mongosh shell tests
# Usage: ./tests/run_all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        go-mongosh  Shell Test Suite               ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}"

# Build binary first
echo ""
echo -e "${YELLOW}Building mongosh binary...${NC}"
cd "${PROJECT_DIR}"
go build -o mongosh ./cmd/mongosh
echo -e "${GREEN}Build successful.${NC}"

# Verify binary exists
if [ ! -x "${PROJECT_DIR}/mongosh" ]; then
    echo -e "${RED}ERROR: mongosh binary not found after build${NC}"
    exit 1
fi

# Load credentials from .env
if [ -f "${SCRIPT_DIR}/.env" ]; then
    source "${SCRIPT_DIR}/.env"
else
    echo -e "${RED}ERROR: tests/.env not found. Copy tests/.env.example to tests/.env and fill in credentials.${NC}"
    exit 1
fi

# Test connectivity before running suite
echo ""
echo -e "${YELLOW}Checking MongoDB connectivity...${NC}"
output=$("${PROJECT_DIR}/mongosh" \
    -uri "${MONGO_URI}" \
    -u "${MONGO_USER}" -p "${MONGO_PASS}" \
    -quiet -eval "db.runCommand({ping: 1})" 2>&1) || true

if echo "$output" | grep -q "ok"; then
    echo -e "${GREEN}MongoDB connection verified.${NC}"
else
    echo -e "${RED}ERROR: Cannot connect to MongoDB${NC}"
    echo "$output"
    exit 1
fi

# Run individual test suites
SUITES_PASSED=0
SUITES_FAILED=0
TOTAL_SUITES=0
FAILED_SUITES=""

run_suite() {
    local script="$1"
    local name
    name=$(basename "$script" .sh | sed 's/test_//')
    TOTAL_SUITES=$((TOTAL_SUITES + 1))

    if bash "$script"; then
        SUITES_PASSED=$((SUITES_PASSED + 1))
    else
        SUITES_FAILED=$((SUITES_FAILED + 1))
        FAILED_SUITES="${FAILED_SUITES}\n    - ${name}"
    fi
}

# Run all test_*.sh files in order
for test_file in "${SCRIPT_DIR}"/test_*.sh; do
    if [ -f "$test_file" ]; then
        run_suite "$test_file"
    fi
done

# Final summary
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║               FINAL RESULTS                       ║${NC}"
echo -e "${CYAN}╠═══════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Suites run:    ${TOTAL_SUITES}                                  ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Suites passed: ${SUITES_PASSED}${NC}                                  ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${RED}Suites failed: ${SUITES_FAILED}${NC}                                  ${CYAN}║${NC}"
if [ "$SUITES_FAILED" -gt 0 ]; then
    echo -e "${CYAN}║${NC}  ${RED}Failed:${FAILED_SUITES}${NC}"
fi
echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$SUITES_FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
