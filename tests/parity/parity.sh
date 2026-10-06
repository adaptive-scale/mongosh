#!/bin/bash
# Parity suite: checks that mongo-sh prints exactly what the reference mongosh
# prints for every snippet in tests/parity/cases.
#
# cases/<name>.js holds snippets separated by lines containing only "###".
# Every snippet runs in its own process as `--quiet --eval <snippet>`; stdout,
# stderr and the exit code are compared. Inside a snippet, __DB__ expands to a
# database name unique to that snippet.
#
# cases/<name>.repl is an interactive session: the whole file is piped to the
# shell's stdin and the complete transcript is compared.
#
# cases/<name>.cli holds whole command lines, one per snippet, written as
# shell words. Placeholders: __CONN__ (address and credentials), __AUTH__
# (credentials only), __PORT__ (server port), __FIX__ (the fixtures directory).
#
# Usage:
#   parity.sh [case ...]            compare mongo-sh with the recorded output
#   parity.sh --record [case ...]   re-record expected/ from the real mongosh
#   parity.sh --show case:N         print both outputs for one snippet
#
# Environment:
#   MONGO_SH_BIN       mongo-sh binary              (default: target/debug/mongo-sh)
#   PARITY_URI         server to test against       (default: mongodb://127.0.0.1:27717)
#   PARITY_USER/PASS   credentials                  (default: admin / password)
#   PARITY_CONTAINER   container with real mongosh  (default: mongo-sh-parity; --record only)
#   PARITY_JOBS        snippets run in parallel     (default: 8)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${MONGO_SH_BIN:-${DIR}/../../target/debug/mongo-sh}"
URI="${PARITY_URI:-mongodb://127.0.0.1:27717}"
USER_NAME="${PARITY_USER:-admin}"
PASSWORD="${PARITY_PASS:-password}"
CONTAINER="${PARITY_CONTAINER:-mongo-sh-parity}"
JOBS="${PARITY_JOBS:-8}"

mode=compare
show=""
cases=()
while [ $# -gt 0 ]; do
    case "$1" in
        --record) mode=record ;;
        --show) mode=show; show="$2"; shift ;;
        *) cases+=("$1") ;;
    esac
    shift
done
if [ "$mode" = show ]; then cases=("${show%%:*}"); fi
if [ ${#cases[@]} -eq 0 ]; then
    for f in "${DIR}"/cases/*.js; do cases+=("$(basename "$f" .js)"); done
    for f in "${DIR}"/cases/*.repl; do [ -e "$f" ] && cases+=("$(basename "$f" .repl)"); done
    for f in "${DIR}"/cases/*.cli; do [ -e "$f" ] && cases+=("$(basename "$f" .cli)"); done
fi

tmp="$(mktemp -d)"
mkdir -p "$tmp/home"
trap 'rm -rf "$tmp"' EXIT

REFERENCE_FIXTURES=/tmp/parity-fixtures
PORT="$(printf '%s' "$URI" | sed -E 's/.*:([0-9]+).*/\1/')"

reference() {
    docker exec -i "$CONTAINER" mongosh --quiet -u "$USER_NAME" -p "$PASSWORD" --authenticationDatabase admin "$@"
}
reference_cli() {
    docker exec -i "$CONTAINER" mongosh "$@"
}
candidate_cli() {
    HOME="$tmp/home" "$BIN" "$@"
}

# Expand the placeholders of a .cli snippet for one of the two shells.
cli_words() {
    local which="$1" text="$2" auth="-u $USER_NAME -p $PASSWORD --authenticationDatabase admin"
    if [ "$which" = reference_cli ]; then
        text="${text//__CONN__/$auth}"
        text="${text//__PORT__/27017}"
        text="${text//__FIX__/$REFERENCE_FIXTURES}"
    else
        text="${text//__CONN__/$URI $auth}"
        text="${text//__PORT__/$PORT}"
        text="${text//__FIX__/${DIR}/fixtures}"
    fi
    printf '%s' "${text//__AUTH__/$auth}"
}
# The candidate gets a private home so its saved settings and history never
# touch (or depend on) the developer's own.
candidate() {
    HOME="$tmp/home" "$BIN" "$URI" --quiet -u "$USER_NAME" -p "$PASSWORD" --authenticationDatabase admin "$@"
}

# Values that legitimately differ between two runs are replaced by markers.
normalize() {
    sed -E \
        -e "s/ObjectId\('[0-9a-f]{24}'\)/ObjectId('<oid>')/g" \
        -e "s/UUID\('[0-9a-f-]{36}'\)/UUID('<uuid>')/g" \
        -e "s/Timestamp\(\{ t: [0-9]+, i: [0-9]+ \}\)/Timestamp(<ts>)/g" \
        -e "s/createFromBase64\('[A-Za-z0-9+\/=]{28}', 0\)/createFromBase64('<hash>', 0)/g" \
        -e "s/keyId: Long\('[0-9]+'\)/keyId: Long('<keyId>')/g" \
        -e "s/ISODate\('20(2[6-9]|[3-9][0-9])-[^']*'\)/ISODate('<now>')/g" \
        -e 's/"\$oid": "[0-9a-f]{24}"/"$oid": "<oid>"/g' \
        -e 's/127\.0\.0\.1:[0-9]+/127.0.0.1:<port>/g' \
        -e "s/$(printf '\r')/<CR>/g" \
        -e "s#${DIR}/fixtures#<fixtures>#g" -e "s#${REFERENCE_FIXTURES}#<fixtures>#g" \
        -e "s/127\.0\.0\.1:(27017|${PORT})/127.0.0.1:<port>/g" \
        -e 's/appName=mongo-?sh\+[0-9.]+/appName=<shell>/g'
}

# Split a case file into $tmp/<case>/<n>.js; echoes the snippet count.
# A .repl session is a single "snippet" holding the whole input.
split_case() {
    local name="$1" file="${DIR}/cases/$1.js" n=0 snippet="" line
    mkdir -p "$tmp/$name"
    if [ -f "${DIR}/cases/$name.repl" ]; then
        sed "s/__DB__/parity_${name}/g" "${DIR}/cases/$name.repl" > "$tmp/$name/1.js"
        echo 1
        return
    fi
    if [ -f "${DIR}/cases/$name.cli" ]; then file="${DIR}/cases/$name.cli"; fi
    flush() {
        if [ -n "${snippet//[[:space:]]/}" ]; then
            n=$((n + 1))
            printf '%s' "${snippet//__DB__/parity_${name}_${n}}" > "$tmp/$name/$n.js"
        fi
        snippet=""
    }
    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$line" = "###" ]; then flush; else snippet+="$line"$'\n'; fi
    done < "$file"
    flush
    echo "$n"
}

run_one() {
    local runner="$1" name="$2" i="$3" out="$4" status
    if [ -f "${DIR}/cases/$name.repl" ]; then
        "$runner" > "$out.stdout" 2> "$out.stderr" < "$tmp/$name/$i.js"
        status=$?
    elif [ -f "${DIR}/cases/$name.cli" ]; then
        local words=()
        eval "words=($(cli_words "${runner}_cli" "$(cat "$tmp/$name/$i.js")"))"
        "${runner}_cli" "${words[@]}" > "$out.stdout" 2> "$out.stderr" < /dev/null
        status=$?
    else
        local code; code="$(cat "$tmp/$name/$i.js")"
        "$runner" --eval "$code" > "$out.stdout" 2> "$out.stderr" < /dev/null
        status=$?
    fi
    {
        cat "$out.stdout"
        if [ -s "$out.stderr" ]; then echo "[stderr]"; cat "$out.stderr"; fi
        echo "[exit $status]"
    } | normalize > "$out"
    rm -f "$out.stdout" "$out.stderr"
}

# A case file whose first line is "// parity: serial" runs one snippet at a
# time, for snippets that change state shared by the whole shell (config).
run_case() {
    local runner="$1" name="$2" count="$3" outdir="$4" i=0 jobs="$JOBS"
    if [ -f "${DIR}/cases/$name.js" ] && head -1 "${DIR}/cases/$name.js" | grep -q 'parity: serial'; then jobs=1; fi
    mkdir -p "$outdir"
    while [ "$i" -lt "$count" ]; do
        i=$((i + 1))
        run_one "$runner" "$name" "$i" "$outdir/$i.txt" &
        if [ $((i % jobs)) -eq 0 ]; then wait; fi
    done
    wait
}

# Scratch databases, and the users and roles defined in them (those live in
# the admin database and survive dropDatabase).
drop_scratch_databases() {
    "$1" --eval "
        var admin = db.getSiblingDB('admin');
        admin.runCommand({usersInfo: {forAllDBs: true}}).users.filter(u => u.db.startsWith('parity_')).forEach(u => db.getSiblingDB(u.db).dropUser(u.user));
        admin.getCollection('system.roles').find({db: /^parity_/}).toArray().forEach(r => db.getSiblingDB(r.db).dropRole(r.role));
        db.getMongo().getDBNames().filter(n => n.startsWith('parity_')).forEach(n => db.getSiblingDB(n).dropDatabase());
    " > /dev/null 2>&1
}

if [ "$mode" = record ]; then
    docker exec "$CONTAINER" rm -rf "$REFERENCE_FIXTURES"
    docker cp "${DIR}/fixtures" "$CONTAINER:$REFERENCE_FIXTURES" > /dev/null
    drop_scratch_databases reference
    for name in "${cases[@]}"; do
        count="$(split_case "$name")"
        rm -rf "${DIR}/expected/$name"
        run_case reference "$name" "$count" "${DIR}/expected/$name"
        echo "recorded $name ($count snippets)"
    done
    drop_scratch_databases reference
    exit 0
fi

if [ ! -x "$BIN" ]; then
    echo "mongo-sh binary not found at $BIN (build it with: cargo build)" >&2
    exit 2
fi

if [ "$mode" = show ]; then
    name="${show%%:*}"; i="${show##*:}"
    split_case "$name" > /dev/null
    echo "--- snippet"; cat "$tmp/$name/$i.js"
    echo "--- expected (mongosh)"; cat "${DIR}/expected/$name/$i.txt"
    run_one candidate "$name" "$i" "$tmp/actual.txt"
    echo "--- actual (mongo-sh)"; cat "$tmp/actual.txt"
    exit 0
fi

drop_scratch_databases candidate
# Snippets listed in known-differences.txt differ from mongosh for a stated
# reason; they are reported but do not fail the run.
known_reason() {
    [ -f "${DIR}/known-differences.txt" ] || return 1
    grep -E "^$1[[:space:]]" "${DIR}/known-differences.txt" | head -1 | sed -E 's/^[^[:space:]]+[[:space:]]+//'
}

total=0; failed=0; known=0; failures=(); stale=()
for name in "${cases[@]}"; do
    count="$(split_case "$name")"
    run_case candidate "$name" "$count" "$tmp/actual/$name"
    case_failed=0; case_known=0
    i=0
    while [ "$i" -lt "$count" ]; do
        i=$((i + 1))
        total=$((total + 1))
        reason="$(known_reason "$name:$i")"
        if diff -q "${DIR}/expected/$name/$i.txt" "$tmp/actual/$name/$i.txt" > /dev/null 2>&1; then
            if [ -n "$reason" ]; then stale+=("$name:$i"); fi
        else
            if [ -n "$reason" ]; then
                known=$((known + 1)); case_known=$((case_known + 1))
                continue
            fi
            failed=$((failed + 1)); case_failed=$((case_failed + 1))
            failures+=("$name:$i")
            if [ -z "${PARITY_SUMMARY:-}" ]; then
                echo "FAIL $name:$i  $(head -1 "$tmp/$name/$i.js" | cut -c1-110)"
                diff "${DIR}/expected/$name/$i.txt" "$tmp/actual/$name/$i.txt" | head -"${PARITY_DIFF_LINES:-24}" | sed 's/^/     /'
            fi
        fi
    done
    echo "$name: $((count - case_failed - case_known))/$count match$([ "$case_known" -gt 0 ] && echo " ($case_known known differences)")"
done
drop_scratch_databases candidate

echo ""
echo "parity: $((total - failed - known))/$total snippets match the reference mongosh, $known known differences, $failed unexpected"
if [ ${#stale[@]} -gt 0 ]; then
    echo "stale entries in known-differences.txt (these match now): ${stale[*]}"
fi
if [ "$failed" -gt 0 ]; then
    echo "differing: ${failures[*]}"
    exit 1
fi
