#!/bin/bash
# Main test runner for the mongo-sh end-to-end shell tests
# Usage: ./tests/run_all.sh
#
# Environment:
#   MONGOSH   shell to test (default: target/release/mongo-sh, built first)
#   MONGO_URI / MONGO_USER / MONGO_PASS   server to test against; read from
#             tests/.env when not set
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
echo -e "${CYAN}║        mongo-sh  Shell Test Suite                 ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════╝${NC}"

# Build the binary first, unless another shell was selected.
if [ -z "${MONGOSH:-}" ]; then
    echo ""
    echo -e "${YELLOW}Building mongo-sh...${NC}"
    (cd "${PROJECT_DIR}" && cargo build --release --quiet)
    echo -e "${GREEN}Build successful.${NC}"
    export MONGOSH="${PROJECT_DIR}/target/release/mongo-sh"
fi

if ! command -v "${MONGOSH}" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: shell not found: ${MONGOSH}${NC}"
    exit 1
fi

# Load credentials from .env unless they are already in the environment
if [ -z "${MONGO_URI:-}" ]; then
    if [ -f "${SCRIPT_DIR}/.env" ]; then
        source "${SCRIPT_DIR}/.env"
    else
        echo -e "${RED}ERROR: tests/.env not found. Copy tests/.env.example to tests/.env and fill in credentials.${NC}"
        exit 1
    fi
fi
export MONGO_URI MONGO_USER MONGO_PASS

# Test connectivity before running suite
echo ""
echo -e "${YELLOW}Checking MongoDB connectivity...${NC}"
output=$("${MONGOSH}" "${MONGO_URI}" \
    -u "${MONGO_USER}" -p "${MONGO_PASS}" --authenticationDatabase "${MONGO_AUTH_DB:-admin}" \
    --quiet --eval "db.runCommand({ping: 1})" 2>&1) || true

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
