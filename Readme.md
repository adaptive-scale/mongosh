<p align="center">
  <img src="assets/logo.svg" alt="mongo-sh" width="800"/>
</p>

`mongo-sh` is a MongoDB shell that behaves like [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/), written in Rust. It is a single self-contained binary of 8–10 MB with no Node.js runtime: the same commands, the same result shapes and the same output formatting, and it connects and runs a command in about 15 ms.

```
$ mongo-sh "mongodb://localhost:27017" -u admin -p
╭─────────────────────────────────────────────────────╮
│  mongo-sh 2.0.0  ·  MongoDB shell, written in Rust  │
╰─────────────────────────────────────────────────────╯

  Connecting to:   mongodb://<credentials>@localhost:27017/?directConnection=true&serverSelectionTimeoutMS=2000&appName=mongo-sh+2.0.0
  Using MongoDB:   8.0.4  (replica set rs0, primary)
  Using mongo-sh:  2.0.0
  Database:        test

  Type help for commands, show dbs to list databases, exit to quit.

rs0 [direct: primary] test> db.users.find({ age: { $gte: 25 } }).sort({ name: 1 })
[
  { _id: ObjectId('65a1f0c2e4b0a1b2c3d4e5f6'), name: 'Alice', age: 30 },
  { _id: ObjectId('65a1f0c2e4b0a1b2c3d4e5f7'), name: 'Bob', age: 41 }
]
```

## Compatibility with mongosh

Compatibility is measured, not assumed. The [parity suite](tests/parity) runs 546 snippets, command lines and interactive sessions through both the real mongosh (2.12.0, against MongoDB 8.0) and mongo-sh, and compares stdout, stderr and exit codes byte for byte:

| | |
|---|---|
| identical output | **534** |
| documented differences | 12 — each listed with its reason in [`known-differences.txt`](tests/parity/known-differences.txt) |
| unexplained differences | 0 |

What that covers:

- **Output formatting** — the `util.inspect` layout rules mongosh inherits from Node.js (line breaking, array column grouping, quoting, colours), BSON type rendering, cursors with `Type "it" for more`, full-depth display of server results in the interactive shell.
- **Collections** — `find`, `findOne`, `insertOne`/`insertMany`, `updateOne`/`updateMany`/`replaceOne`, `deleteOne`/`deleteMany`, `findOneAnd*`, `findAndModify`, `bulkWrite`, `aggregate`, `countDocuments`, `estimatedDocumentCount`, `distinct`, index management, `stats`, `validate`, `renameCollection`, `explain()`, `watch()`, the legacy `Bulk` API, plan cache, map-reduce, Atlas Search index helpers.
- **Cursors** — every chaining method (`sort`, `limit`, `skip`, `projection`, `hint`, `collation`, `batchSize`, `maxTimeMS`, `readPref`, `tailable`, …), `map`/`forEach`/`toArray`/`next`/`tryNext`/`hasNext`, `explain`, `objsLeftInBatch`, `isClosed`/`isExhausted`.
- **Databases** — `runCommand`/`adminCommand`, `aggregate`, user and role management, `auth`/`logout`, `createCollection`/`createView`, `currentOp`/`killOp`, profiling, log levels, `stats`, `serverStatus`, `watch`.
- **Connections and sessions** — `Mongo`, `connect()`, read preference / read concern / write concern, `startSession()`, multi-document transactions, `withTransaction`.
- **Replica sets and sharding** — the `rs` and `sh` helpers.
- **BSON types** — `ObjectId`, `Long`/`NumberLong`, `Int32`/`NumberInt`, `Double`, `Decimal128`/`NumberDecimal`, `Timestamp`, `Binary`/`BinData`/`HexData`/`MD5`, `UUID` and the legacy UUID encodings, `MinKey`, `MaxKey`, `BSONRegExp`, `BSONSymbol`, `Code`, `DBRef`, `ISODate`, plus `EJSON` and `bsonsize`.
- **Shell** — `use`, `show dbs|collections|users|roles|profile|logs|log`, `it`, `help`, `load()`, `print`/`printjson`, `config`, `--eval`, script files, `--json`, `--shell`, `--nodb`, `~/.mongoshrc.js`, command history, tab completion, multi-line input, Ctrl-C to interrupt a running operation.
- **Errors** — the same error classes, codes and messages (`MongoServerError`, `MongoBulkWriteError`, `MongoshInvalidInputError: [COMMON-10001] …`), on stderr with exit code 1 in scripts.

### Where it differs

mongo-sh embeds the [QuickJS](https://github.com/quickjs-ng/quickjs) engine and the official MongoDB Rust driver instead of Node.js and the Node driver. That is what makes it small and quick to start, and it is also the source of the differences:

- **No Node.js APIs.** `require()`, npm packages, `process`, `Buffer`, `fs` and friends are not available, so neither are mongosh snippets. `load()` works for local scripts.
- **JavaScript error wording.** Syntax errors are reported by QuickJS rather than Babel, so their text and position differ. The most common runtime errors (`x is not a function`, `Cannot read properties of undefined`) are displayed in the Node.js wording, but `error.message` carries the engine's own.
- **Not included:** client-side field level encryption, OIDC, AWS IAM and Kerberos authentication, the `edit` command, telemetry and the `log` global. SCRAM and X.509 authentication and TLS (`--tls`, `--tlsCAFile`, `--tlsCertificateKeyFile`) are supported.
- **Writes are not retried automatically.** Operations are sent as plain server commands, which the driver does not retry after a network error.
- **Help text** has the same layout as mongosh's, with descriptions written for this project.
- **Small extras:** top-level `await` works in `--eval` and scripts, and `tojson()` / `tojsononeline()` from the legacy `mongo` shell are kept.

## Installation

### Install script (Linux, macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/adaptive-scale/mongo-sh/master/install.sh | sh
```

The script detects your OS and CPU, downloads the matching binary from the latest [release](https://github.com/adaptive-scale/mongo-sh/releases), verifies its SHA-256 checksum and installs it to `/usr/local/bin` (or `~/.local/bin` if that is not writable).

```bash
# a specific version
curl -fsSL https://raw.githubusercontent.com/adaptive-scale/mongo-sh/master/install.sh | MONGO_SH_VERSION=v2.0.0 sh

# a different directory
curl -fsSL https://raw.githubusercontent.com/adaptive-scale/mongo-sh/master/install.sh | MONGO_SH_INSTALL_DIR="$HOME/bin" sh
```

### Manual download

Each release has one archive per platform, containing the `mongo-sh` binary:

| Platform | Archive |
|---|---|
| Linux x86-64 / ARM64 (static, any distribution) | `mongo-sh-linux-amd64.tar.gz` / `mongo-sh-linux-arm64.tar.gz` |
| macOS Intel / Apple Silicon | `mongo-sh-darwin-amd64.tar.gz` / `mongo-sh-darwin-arm64.tar.gz` |
| Windows x86-64 / ARM64 | `mongo-sh-windows-amd64.zip` / `mongo-sh-windows-arm64.zip` |

```bash
curl -fsSLO https://github.com/adaptive-scale/mongo-sh/releases/latest/download/mongo-sh-linux-amd64.tar.gz
tar -xzf mongo-sh-linux-amd64.tar.gz mongo-sh
sudo mv mongo-sh /usr/local/bin/
```

### From source

Requires a Rust toolchain and a C compiler (QuickJS is compiled from source).

```bash
git clone https://github.com/adaptive-scale/mongo-sh.git
cd mongo-sh
make build        # target/release/mongo-sh
make install      # or: cargo install --path .
```

## Usage

The command line is mongosh's:

```bash
# Connect to localhost:27017 (default)
mongo-sh

# Connect with a URI, a host/port, or just a database name
mongo-sh "mongodb+srv://cluster0.example.mongodb.net/mydb"
mongo-sh --host myhost --port 27018
mongo-sh mydb

# Authenticate (-p without a value prompts for the password)
mongo-sh -u admin -p
mongo-sh -u admin -p secret --authenticationDatabase admin

# Evaluate and exit; only the result of the last --eval is printed
mongo-sh --quiet --eval 'db.orders.countDocuments({ status: "open" })'

# Machine-readable output
mongo-sh --quiet --json=relaxed --eval 'db.orders.findOne()'

# Run script files, then optionally stay in the shell
mongo-sh migrate.js seed.js
mongo-sh --shell setup.js

# No connection: just the JavaScript shell and BSON types
mongo-sh --nodb
```

Run `mongo-sh --help` for every option.

## Shell examples

```javascript
// Switch database, list collections
use mydb
show collections

// Insert
db.users.insertOne({ name: "Alice", age: 30 })
db.users.insertMany([{ name: "Bob" }, { name: "Charlie" }])

// Query
db.users.find({ age: { $gte: 25 } }).sort({ name: 1 }).limit(10)
db.users.findOne({ name: "Alice" })

// Update and delete
db.users.updateOne({ name: "Alice" }, { $set: { age: 31 } })
db.users.deleteMany({ status: "inactive" })

// Aggregation
db.orders.aggregate([
  { $match: { status: "completed" } },
  { $group: { _id: "$customerId", total: { $sum: "$amount" } } },
  { $sort: { total: -1 } }
])

// Indexes and query plans
db.users.createIndex({ email: 1 }, { unique: true })
db.users.find({ age: { $gt: 25 } }).explain("executionStats")

// Transactions
const session = db.getMongo().startSession()
session.withTransaction(() => {
  const accounts = session.getDatabase("bank").accounts
  accounts.updateOne({ _id: "a" }, { $inc: { balance: -100 } })
  accounts.updateOne({ _id: "b" }, { $inc: { balance: 100 } })
})

// Administration
db.serverStatus()
db.currentOp()
rs.status()
sh.status()
```

## Building and testing

```bash
make build            # release build for this machine
make test             # Rust unit tests
make e2e              # end-to-end shell tests (needs MongoDB: copy tests/.env.example to tests/.env)
make parity           # compare with the recorded output of the real mongosh
make release          # cross-compile every platform in Docker, archives in dist/
make gh-release       # publish dist/ as a GitHub release (requires gh)
```

### Release builds

`make release` builds all six platforms inside one Docker image ([`Dockerfile.build`](Dockerfile.build)) using [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild), so the only requirement on the build machine is Docker:

```bash
make release                                      # everything
make release PLATFORMS="linux/amd64 darwin/arm64" # a subset
```

Archives and `checksums.txt` are written to `dist/`, named as the install script expects.

### The parity suite

`tests/parity/cases` holds the snippets; `tests/parity/expected` holds what the real mongosh printed for each of them.

```bash
make parity-server    # start MongoDB 8.0 + mongosh in Docker (single-node replica set)
make parity           # run mongo-sh against it and compare with expected/
make parity-record    # re-record expected/ from the real mongosh after adding cases
make parity-server-stop
```

`tests/parity/parity.sh --show collection:12` prints the snippet with both outputs side by side. The end-to-end tests in `tests/` are shell-agnostic as well: `MONGOSH=mongosh make e2e` runs them against the real mongosh.

## Architecture

```
src/
  main.rs       entry point: modes (--eval, files, interactive), exit codes
  cli.rs        mongosh-compatible argument parsing and connection strings
  engine.rs     QuickJS setup, evaluation of user code, top-level await
  lexer.rs      multi-line detection and REPL-style redeclaration of let/const/class
  native.rs     the bridge to the MongoDB driver: commands, cursors, sessions
  convert.rs    JS <-> BSON conversion
  repl.rs       line editing, history, completion
  js/           the shell itself, in JavaScript:
    inspect.js    value formatting (Node's util.inspect algorithm)
    bson.js       BSON types          ejson.js    Extended JSON
    errors.js     error classes       help.js     help system
    cursor.js  collection.js  database.js  mongo.js  rs.js  sh.js  shell.js
tests/
  parity/       output comparison against the real mongosh
  test_*.sh     end-to-end shell tests
```

The shell API is implemented in JavaScript on top of a small native bridge: `runCommand`, driver-managed cursors and sessions. Every helper builds the same server command the Node.js driver would send, which is why options pass through unchanged.

## Coming from go-mongosh 1.x

This project was previously `go-mongosh`, written in Go. Version 2 is a rewrite:

- The binary is now `mongo-sh`.
- The connection string is a positional argument, as in mongosh. The old `-uri` flag and single-dash spellings such as `-eval` and `-quiet` are still accepted.
- Output now matches mongosh: strings in single quotes, `Long('5')`, `insertedIds: { '0': … }` and so on. Scripts that parsed the old output need updating.
- A script run (`--eval`, files) prints only its result; the banner is shown by the interactive shell.
- `db.auth()`, sessions, transactions, change streams, `--json` and script files are new.

## License

See [LICENSE](LICENSE) for details.
