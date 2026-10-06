// The shell itself: global commands and functions, result formatting, the
// prompt, the startup banner and tab completion.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const native = msh.native;
  const { asPrintable } = msh.symbols;
  const { CommandResult, CursorIterationResult, Help } = msh;
  const { MongoshInvalidInputError, MongoshUnimplementedError } = msh.errors;

  msh.mongo = null;
  msh.currentDb = null;
  msh.currentCursor = null;
  msh.lastSource = null;

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  /**
   * Options for printing the result of a line. Script output (--eval, files)
   * is never truncated; the interactive shell honours the config settings.
   */
  function displayOptions(extra) {
    const user = msh.config.user;
    const base = msh.config.interactive
      ? { depth: user.inspectDepth, compact: user.inspectCompact }
      : { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, compact: user.inspectCompact };
    return Object.assign({ colors: msh.config.colors, breakLength: 80 }, base, extra);
  }

  /** Options for print() and console.log(): bounded depth in every mode. */
  function printOptions(extra) {
    const user = msh.config.user;
    return Object.assign({ colors: msh.config.colors, breakLength: 80, depth: user.inspectDepth, compact: user.inspectCompact }, extra);
  }

  const PRINTJSON_OPTIONS = { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, compact: false };

  msh.inspectForDisplay = (value) => msh.inspect(value, displayOptions());

  function textTable(rows, align) {
    const widths = [];
    for (const row of rows) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] || 0, msh.removeColors(String(cell)).length);
      });
    }
    return rows
      .map((row) => row
        .map((cell, i) => {
          const text = String(cell);
          const pad = ' '.repeat(widths[i] - msh.removeColors(text).length);
          return align[i] === 'r' ? pad + text : text + pad;
        })
        .join('  ')
        .replace(/\s+$/, ''))
      .join('\n');
  }

  function formatBytes(value) {
    const suffixes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const bytes = Number(value);
    if (!bytes) return `0 ${suffixes[0]}`;
    const exponent = Math.min(suffixes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, exponent)).toFixed(2)} ${suffixes[exponent]}`;
  }

  const bold = (text) => (msh.config.colors ? `\u001b[1m${text}\u001b[22m` : text);
  const tint = (text, code) => (msh.config.colors ? `\u001b[${code}m${text}\u001b[39m` : text);

  function formatSimple(value, options) {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    return msh.inspect(value, options);
  }

  function formatIteration(result, options) {
    if (!result.documents.length) return 'no cursor';
    let text = msh.inspect(result.documents, options);
    if (result.cursorHasMore) text += '\nType "it" for more';
    return text;
  }

  function formatTyped(type, value, options) {
    switch (type) {
      case 'Help':
        return msh.formatHelp(value);
      case 'ShowDatabasesResult':
        return textTable(value.map((db) => [bold(db.name), formatBytes(db.sizeOnDisk)]), ['l', 'r']);
      case 'ShowCollectionsResult': {
        const isSystem = (c) => c.name.startsWith('system.') || c.name.startsWith('enxcol_.');
        const rows = [
          ...value.filter((c) => !isSystem(c)).map((c) => [bold(c.name), c.badge]),
          ...value.filter(isSystem).map((c) => [tint(c.name, 90), c.badge]),
        ];
        return textTable(rows, ['l', 'l']);
      }
      case 'StatsResult':
        return Object.keys(value).map((key) => `${bold(tint(key, 33))}\n${msh.inspect(value[key], options)}`).join('\n---\n');
      case 'ListCommandsResult':
        return Object.keys(value).map((name) => {
          const command = value[name];
          let line = `${bold(tint(name, 33))}: `;
          for (const key of Object.keys(command)) {
            if (key !== 'help' && command[key]) line += ` ${bold(key)}`;
          }
          return command.help ? `${line}\n${tint(command.help, 32)}` : line;
        }).join('\n\n');
      case 'ShowProfileResult':
        if (value.count === 0) {
          return 'db.system.profile is empty.\nUse db.setProfilingLevel(2) will enable profiling.\nUse db.getCollection(\'system.profile\').find() to show raw profile entries.';
        }
        return value.result.map((entry) => {
          const head = `${entry.op}\t${entry.ns} ${entry.millis}ms ${String(entry.ts).substring(0, 24)}\n`;
          let rest = '';
          for (const key of Object.keys(entry)) {
            if (key === 'op' || key === 'ns' || key === 'millis' || key === 'ts') continue;
            const item = entry[key];
            if (typeof item === 'object') rest += `${key}:${formatSimple(item, options)} `;
            else if (typeof item === 'boolean') rest += `${key} `;
            else rest += `${key}:${item} `;
          }
          return head + rest;
        }).join('\n');
      case 'ShowBannerResult': {
        if (!value) return '';
        let text = '------\n';
        if (value.header) text += `   ${value.header}\n`;
        text += `${value.content.trim().replace(/^/gm, '   ')}\n`;
        return `${text}------\n`;
      }
      default:
        return formatSimple(value, options);
    }
  }

  /** Format any value the way it is shown as the result of a line. */
  function formatValue(value, options) {
    if (value instanceof Error) return msh.formatError(value);
    if (value instanceof CursorIterationResult) return formatIteration(value, options);
    const printable = msh.printable(value);
    if (printable instanceof CursorIterationResult) {
      // A cursor that was just displayed is what `it` continues.
      if (value instanceof msh.AbstractCursor) {
        msh.currentCursor = value;
        return printable.documents.length ? formatIteration(printable, options) : '';
      }
      return formatIteration(printable, options);
    }
    return formatTyped(msh.typeOf(value), printable, options);
  }

  function jsonPrintable(value) {
    const printable = msh.printable(value);
    if (printable instanceof CursorIterationResult) return printable.documents;
    if (printable instanceof Help) return msh.formatHelp(printable);
    return printable;
  }

  /** The text to print for the result of a line, or null to print nothing. */
  msh.formatResult = function (value) {
    if (value === undefined) return null;
    if (msh.config.json) {
      return msh.EJSON.stringify(jsonPrintable(value), null, 2, { relaxed: msh.config.json === 'relaxed' });
    }
    return formatValue(value, displayOptions());
  };

  // ------------------------------------------------------------------
  // print and friends
  // ------------------------------------------------------------------

  function printValues(values, options) {
    msh.println(values.map((value) => formatValue(value, options)).join(' '));
  }

  function print(...values) {
    printValues(values, printOptions());
  }

  function printjson(...values) {
    printValues(values, printOptions(PRINTJSON_OPTIONS));
  }

  const console = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[method] = (...values) => printValues(values, printOptions());
  }
  console.dir = (value, options) => msh.println(msh.inspect(value, printOptions(options)));
  console.table = (value) => printValues([value], printOptions());
  console.assert = (condition, ...values) => {
    if (!condition) printValues(['Assertion failed', ...values], printOptions());
  };
  console.clear = () => msh.write('\u001b[2J\u001b[3J\u001b[H');
  const timers = new Map();
  const counts = new Map();
  console.time = (label = 'default') => timers.set(label, Date.now());
  console.timeLog = (label = 'default', ...values) => {
    if (timers.has(label)) printValues([`${label}: ${Date.now() - timers.get(label)}ms`, ...values], printOptions());
  };
  console.timeEnd = (label = 'default') => {
    console.timeLog(label);
    timers.delete(label);
  };
  console.count = (label = 'default') => {
    counts.set(label, (counts.get(label) || 0) + 1);
    msh.println(`${label}: ${counts.get(label)}`);
  };
  console.countReset = (label = 'default') => counts.delete(label);
  console.group = (...values) => {
    if (values.length) printValues(values, printOptions());
  };
  console.groupEnd = () => {};

  // Legacy mongo shell helpers kept for scripts written against it.
  function tojson(value, indent, nolint) {
    if (nolint) return msh.inspect(value, { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity });
    return msh.inspect(value, PRINTJSON_OPTIONS);
  }
  const tojsononeline = (value) => tojson(value, '', true);

  // ------------------------------------------------------------------
  // Database switching and the `db` global
  // ------------------------------------------------------------------

  msh.setCurrentDb = function (db) {
    msh.currentDb = db;
    msh.rs = new msh.ReplicaSet(db);
    msh.sh = new msh.Shard(db);
  };

  const noDatabase = () => new MongoshInvalidInputError('No connected database', 'SHAPI-10004');

  Object.defineProperty(g, 'db', {
    get() {
      if (msh.currentDb === null) throw noDatabase();
      return msh.currentDb;
    },
    set(value) {
      if (msh.typeOf(value) !== 'Database') {
        throw new msh.errors.MongoshInvalidInputError("Cannot reassign 'db' to non-Database type", 'COMMON-10002');
      }
      msh.setCurrentDb(value);
    },
    enumerable: true,
    configurable: true,
  });
  for (const name of ['rs', 'sh']) {
    Object.defineProperty(g, name, {
      get() {
        if (msh[name] === undefined || msh.currentDb === null) throw noDatabase();
        return msh[name];
      },
      set(value) {
        Object.defineProperty(g, name, { value, writable: true, enumerable: true, configurable: true });
      },
      enumerable: true,
      configurable: true,
    });
  }

  function requireMongo() {
    if (msh.mongo === null) throw noDatabase();
    return msh.currentDb._mongo;
  }

  // ------------------------------------------------------------------
  // show
  // ------------------------------------------------------------------

  const SHOW_TOPICS = ['databases', 'dbs', 'collections', 'tables', 'profile', 'users', 'roles', 'log', 'logs', 'startupWarnings'];

  msh.show = function (mongo, cmd, arg) {
    const db = msh.currentDb && msh.currentDb._mongo === mongo ? msh.currentDb : mongo.getDB(mongo._defaultDatabase);
    switch (cmd) {
      case 'databases':
      case 'dbs': {
        const reply = mongo._run('admin', { listDatabases: 1 }, { readPreference: { mode: 'primaryPreferred' } });
        return new CommandResult('ShowDatabasesResult', reply.databases);
      }
      case 'collections':
      case 'tables':
        return new CommandResult('ShowCollectionsResult', db._getCollectionNamesWithTypes());
      case 'profile': {
        const profile = db.getCollection('system.profile');
        const result = { count: profile.countDocuments({}) };
        if (result.count !== 0) {
          result.result = profile.find({ millis: { $gt: 0 } }).sort({ $natural: -1 }).limit(5).toArray();
        }
        return new CommandResult('ShowProfileResult', result);
      }
      case 'users':
        return new CommandResult('ShowResult', db.getUsers().users);
      case 'roles':
        return new CommandResult('ShowResult', db.getRoles({ showBuiltinRoles: true }).roles);
      case 'log':
        return new CommandResult('ShowResult', db.adminCommand({ getLog: arg || 'global' }).log);
      case 'logs':
        return new CommandResult('ShowResult', db.adminCommand({ getLog: '*' }).names);
      case 'startupWarnings': {
        const lines = db.adminCommand({ getLog: 'startupWarnings' }).log || [];
        if (!lines.length) return new CommandResult('ShowBannerResult', null);
        const content = lines.map((line) => {
          try {
            const entry = JSON.parse(line);
            return `${entry.t.$date}: ${entry.msg}`;
          } catch {
            return line;
          }
        });
        return new CommandResult('ShowBannerResult', {
          header: 'The server generated these startup warnings when booting',
          content: content.join('\n'),
        });
      }
      default:
        throw msh.invalidInput(`'${cmd}' is not a valid argument for "show".`);
    }
  };

  // ------------------------------------------------------------------
  // Global functions
  // ------------------------------------------------------------------

  function use(db) {
    msh.required([db], 1, 'Mongo.use');
    return requireMongo().use(db);
  }

  function show(cmd, arg) {
    return msh.show(requireMongo(), cmd, arg);
  }

  function it() {
    if (msh.currentCursor === null) return new CursorIterationResult();
    return msh.currentCursor._it();
  }

  function exit(code) {
    native.exit(typeof code === 'number' ? code : Number(code) || 0);
  }

  function cls() {
    console.clear();
  }

  function sleep(ms) {
    native.sleep(Number(ms) || 0);
  }

  function version() {
    return msh.version;
  }

  function isInteractive() {
    return msh.config.interactive;
  }

  function passwordPrompt() {
    return native.passwordPrompt('Enter password\n');
  }

  function load(filename) {
    msh.required([filename], 1, 'load');
    if (typeof filename !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof filename} instead (load)`);
    const source = native.readFile(filename);
    const previous = { filename: g.__filename, dirname: g.__dirname };
    const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
    g.__filename = filename;
    g.__dirname = slash === -1 ? '.' : filename.slice(0, slash) || '/';
    try {
      msh.lastSource = source;
      native.evalScript(source, filename);
    } finally {
      g.__filename = previous.filename;
      g.__dirname = previous.dirname;
    }
    return true;
  }

  function connect(uri, user, pwd) {
    msh.required([uri], 1, 'connect');
    if (typeof uri !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof uri} instead (connect)`);
    const mongo = new msh.Mongo(uri);
    if (user !== undefined || pwd !== undefined) {
      mongo._reconnect({ username: user, password: pwd });
    }
    return mongo.getDB(mongo._defaultDatabase);
  }

  const telemetry = (state) => () => {
    msh.config.user.enableTelemetry = false;
    return `Telemetry is not collected by mongo-sh; nothing to ${state}.`;
  };

  function unsupported(name, reason) {
    return () => {
      throw new MongoshUnimplementedError(`${name} is not available in mongo-sh: ${reason}`, 'COMMON-90002');
    };
  }

  // ---- config ----------------------------------------------------------

  /** Settings changed with config.set() are kept across sessions. */
  function saveUserConfig() {
    const path = native.stateFile('config.json');
    if (path === null) return;
    const changed = {};
    for (const key of Object.keys(msh.config.user)) {
      if (msh.config.user[key] !== DEFAULT_USER_CONFIG[key]) changed[key] = msh.config.user[key];
    }
    native.writeFile(path, JSON.stringify(changed));
  }

  function loadUserConfig() {
    const path = native.stateFile('config.json');
    if (path === null) return;
    let saved;
    try {
      saved = JSON.parse(native.readFile(path));
    } catch {
      return;
    }
    for (const key of Object.keys(saved || {})) {
      if (key in DEFAULT_USER_CONFIG) msh.config.user[key] = saved[key];
    }
  }

  class ShellConfig {
    get(key) {
      msh.required([key], 1, 'ShellConfig.get');
      return msh.config.user[key];
    }

    set(key, value) {
      msh.required([key, value], 2, 'ShellConfig.set');
      if (!(key in msh.config.user)) return `Option "${key}" is not available in this environment`;
      const numeric = ['displayBatchSize', 'inspectDepth', 'historyLength'];
      if (numeric.includes(key) && (typeof value !== 'number' || !(value > 0))) {
        return `Cannot set option "${key}": ${key} must be a positive integer`;
      }
      if (key === 'inspectCompact' && typeof value !== 'boolean' && (typeof value !== 'number' || value < 0)) {
        return 'Cannot set option "inspectCompact": inspectCompact must be a boolean or a positive integer';
      }
      if (key === 'redactHistory' && !['keep', 'remove', 'remove-redact'].includes(value)) {
        return 'Cannot set option "redactHistory": redactHistory must be one of \'keep\', \'remove\', or \'remove-redact\'';
      }
      msh.config.user[key] = value;
      saveUserConfig();
      return `Setting "${key}" has been changed`;
    }

    reset(key) {
      msh.required([key], 1, 'ShellConfig.reset');
      if (key in DEFAULT_USER_CONFIG) {
        msh.config.user[key] = DEFAULT_USER_CONFIG[key];
        saveUserConfig();
      }
      return `Setting "${key}" has been reset to its default value`;
    }

    [asPrintable]() {
      return new Map(Object.entries(msh.config.user));
    }
  }
  const DEFAULT_USER_CONFIG = Object.assign({}, msh.config.user);
  msh.describeClass(ShellConfig, {
    type: 'ShellConfig',
    help: 'Shell Config',
    prefix: 'config',
    docs: msh.docs.shell,
    methods: {
      get: 'Returns the value of a setting.',
      set: 'Changes a setting for this session.',
      reset: 'Restores a setting to its default.',
    },
  });

  // DBQuery.shellBatchSize is the legacy way to set the display batch size;
  // while set, it takes precedence over config.displayBatchSize.
  const DBQuery = {
    Option: { tailable: 2, slaveOk: 4, oplogReplay: 8, noTimeout: 16, awaitData: 32, exhaust: 64, partial: 128 },
  };
  let legacyBatchSize;
  Object.defineProperty(DBQuery, 'shellBatchSize', {
    get: () => legacyBatchSize,
    set: (value) => {
      msh.deprecated('DBQuery.shellBatchSize is deprecated, please use config.set("displayBatchSize") instead');
      legacyBatchSize = value;
    },
    enumerable: true,
  });
  msh.displayBatchSize = () => (legacyBatchSize !== undefined ? legacyBatchSize : msh.config.user.displayBatchSize);

  // ---- help --------------------------------------------------------------

  const shellHelp = msh.helpFunction({
    help: 'Shell Help',
    docs: msh.docs.manual,
    attr: [
      { name: 'use', description: 'Set current database' },
      {
        name: 'show',
        description: [
          "'show databases'/'show dbs': Print a list of all available databases",
          "'show collections'/'show tables': Print a list of all collections for current database",
          "'show profile': Prints system.profile information",
          "'show users': Print a list of all users for current database",
          "'show roles': Print a list of all roles for current database",
          "'show log <name>': Display log for current connection, if name is not set uses 'global'",
          "'show logs': Print all logger names.",
        ].join('\n'),
      },
      { name: 'exit', description: 'Quit the MongoDB shell with exit/exit()/.exit' },
      { name: 'quit', description: 'Quit the MongoDB shell with quit/quit()' },
      { name: 'Mongo', description: 'Create a new connection and return the Mongo object. Usage: new Mongo(URI, options [optional])' },
      { name: 'connect', description: 'Create a new connection and return the Database object. Usage: connect(URI, username [optional], password [optional])' },
      { name: 'it', description: 'result of the last line evaluated; use to further iterate' },
      { name: 'version', description: 'Shell version' },
      { name: 'load', description: 'Loads and runs a JavaScript file into the current shell environment' },
      { name: 'passwordPrompt', description: 'Prompts the user for a password' },
      { name: 'sleep', description: 'Sleep for the specified number of milliseconds' },
      { name: 'print', description: 'Prints the contents of an object to the output' },
      { name: 'printjson', description: 'Alias for print()' },
      { name: 'convertShardKeyToHashed', description: 'Returns the hashed value for the input using the same hashing function as a hashed index.' },
      { name: 'cls', description: 'Clears the screen like console.clear()' },
      { name: 'isInteractive', description: 'Returns whether the shell will enter or has entered interactive mode' },
      { name: 'config', description: "'config.get(<key>)'/'config.set(<key>, <value>)': Read or change shell settings such as displayBatchSize and inspectDepth" },
    ],
  });

  // ---- installation ------------------------------------------------------

  /** Shell functions are regular globals the user may shadow. */
  function install(name, value, enumerable = true) {
    Object.defineProperty(g, name, { value, writable: true, enumerable, configurable: true });
  }

  const quit = exit;
  for (const [name, fn] of Object.entries({
    use, show, it, exit, quit, cls, sleep, version, isInteractive, passwordPrompt, load, connect, print, printjson,
  })) {
    install(name, fn);
  }
  install('help', shellHelp);
  install('console', console);
  install('Mongo', msh.Mongo);
  install('config', new ShellConfig());
  install('DBQuery', DBQuery);
  install('enableTelemetry', telemetry('enable'));
  install('disableTelemetry', telemetry('disable'));
  install('convertShardKeyToHashed', (value) => requireMongo().convertShardKeyToHashed(value));
  install('buildInfo', () => ({ version: msh.version, runtimeArch: native.arch, runtimePlatform: native.platform, runtime: 'QuickJS', driver: 'mongodb (Rust)' }));
  install('edit', unsupported('edit', 'there is no external editor integration'));
  install('snippet', unsupported('snippet', 'the npm-based snippet system needs Node.js'));
  install('require', (name) => {
    throw new MongoshUnimplementedError(`require(${JSON.stringify(name)}) is not available: mongo-sh does not embed Node.js. Use load() for local scripts.`, 'COMMON-90002');
  });
  // Legacy `mongo` shell helpers that mongosh dropped.
  install('tojson', tojson, false);
  install('tojsononeline', tojsononeline, false);
  install('hostname', () => native.hostname(), false);
  install('pwd', () => native.cwd(), false);
  install('cd', (path) => native.chdir(String(path)), false);
  install('globalThis', g, false);

  // ------------------------------------------------------------------
  // Direct shell commands: `use db`, `show dbs`, `it`, `exit`, ...
  // ------------------------------------------------------------------

  const DIRECT_COMMANDS = { use, show, it, exit, quit, cls };

  function splitCommand(input) {
    const argv = String(input).trim().replace(/;$/, '').split(/\s+/g);
    const name = argv.shift();
    return Object.prototype.hasOwnProperty.call(DIRECT_COMMANDS, name) ? { name, argv } : null;
  }

  msh.isDirectCommand = (input) => splitCommand(input) !== null;

  msh.runDirectCommand = function (input) {
    msh.lastSource = String(input);
    const command = splitCommand(input);
    if (command === null) return msh.NOT_A_COMMAND;
    // A user variable or function with the same name wins once it is called
    // like one, e.g. `it(...)` or `use = 5`; only bare words are commands.
    return DIRECT_COMMANDS[command.name](...command.argv);
  };

  // ------------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------------

  msh.setup = function (config) {
    for (const key of ['interactive', 'quiet', 'colors', 'isTTY', 'json', 'deepInspect', 'serverApi']) {
      if (config[key] !== undefined) msh.config[key] = config[key];
    }
    // Server results are shown in full by default in the interactive shell.
    if (msh.config.deepInspect === undefined) msh.config.deepInspect = !!msh.config.interactive;
    loadUserConfig();
  };

  msh.connectInitial = function (uri, redacted) {
    const mongo = new msh.Mongo({ __normalized: true, uri, redacted });
    msh.mongo = mongo;
    msh.setCurrentDb(mongo.getDB(mongo._defaultDatabase));
  };

  msh.loadFile = (path) => load(path);

  function topologyLabel(hello, direct) {
    if (!hello) return '';
    if (hello.msg === 'isdbgrid') return direct ? '[direct: mongos]' : '[mongos]';
    if (!hello.setName) return '';
    let role = 'other';
    if (hello.isWritablePrimary || hello.ismaster) role = 'primary';
    else if (hello.secondary) role = 'secondary';
    else if (hello.arbiterOnly) role = 'arbiter';
    return direct ? `${hello.setName} [direct: ${role}]` : `${hello.setName} [${role === 'other' ? 'secondary' : role}]`;
  }

  function deploymentPrefix(mongo) {
    if (/\.mongodb(-dev|-qa|-stage)?\.net(:\d+)?([,/?]|$)/.test(mongo._uri)) return 'Atlas';
    if (msh.serverBuildInfo && Array.isArray(msh.serverBuildInfo.modules) && msh.serverBuildInfo.modules.includes('enterprise')) return 'Enterprise';
    return '';
  }

  msh.prompt = function () {
    // A user-defined `prompt` (string or function) replaces the default.
    const custom = Object.getOwnPropertyDescriptor(g, 'prompt');
    if (custom && 'value' in custom) {
      try {
        if (typeof custom.value === 'function') return String(custom.value());
        if (typeof custom.value === 'string') return custom.value;
      } catch { /* fall back to the default prompt */ }
    }
    if (msh.currentDb === null) return '> ';
    const mongo = msh.currentDb._mongo;
    let topology = '';
    try {
      topology = topologyLabel(mongo._hello(), /[?&]directConnection=true/i.test(mongo._uri));
    } catch { /* server unreachable: show the plain prompt */ }
    return `${[deploymentPrefix(mongo), topology, msh.currentDb._name].filter(Boolean).join(' ')}> `;
  };

  /** The interactive startup banner. */
  msh.banner = function () {
    const color = msh.config.colors;
    const green = (text) => (color ? `\u001b[38;5;35m${text}\u001b[39m` : text);
    const dim = (text) => (color ? `\u001b[2m${text}\u001b[22m` : text);
    const strong = (text) => (color ? `\u001b[1m${text}\u001b[22m` : text);

    const title = `mongo-sh ${msh.version}`;
    const tagline = 'MongoDB shell, written in Rust';
    const inner = `  ${title}  ·  ${tagline}  `;
    const rule = '─'.repeat(inner.length);
    const lines = [
      green(`╭${rule}╮`),
      `${green('│')}  ${strong(green(title))}  ${dim('·')}  ${tagline}  ${green('│')}`,
      green(`╰${rule}╯`),
    ];

    const rows = [];
    if (msh.currentDb !== null) {
      const mongo = msh.currentDb._mongo;
      rows.push(['Connecting to', mongo._redactedUri]);
      try {
        msh.serverBuildInfo = mongo._run('admin', { buildInfo: 1 }, {});
        let server = msh.serverBuildInfo.version;
        const hello = mongo._hello();
        if (hello.msg === 'isdbgrid') server += '  (mongos)';
        else if (hello.setName) {
          const role = hello.isWritablePrimary || hello.ismaster ? 'primary' : hello.secondary ? 'secondary' : hello.arbiterOnly ? 'arbiter' : 'other';
          server += `  (replica set ${hello.setName}, ${role})`;
        } else {
          server += '  (standalone)';
        }
        rows.push(['Using MongoDB', server]);
      } catch { /* not allowed to run buildInfo: leave the row out */ }
      rows.push(['Using mongo-sh', msh.version]);
      rows.push(['Database', msh.currentDb._name]);
    } else {
      rows.push(['Using mongo-sh', msh.version]);
      rows.push(['Database', 'not connected (--nodb)']);
    }
    const width = Math.max(...rows.map(([label]) => label.length));
    lines.push('');
    for (const [label, value] of rows) lines.push(`  ${dim(`${label}:`.padEnd(width + 1))}  ${value}`);
    lines.push('');
    lines.push(`  ${dim('Type')} help ${dim('for commands,')} show dbs ${dim('to list databases,')} exit ${dim('to quit.')}`);

    if (msh.currentDb !== null) {
      try {
        const warnings = msh.show(msh.currentDb._mongo, 'startupWarnings');
        if (warnings.value) lines.push('', formatTyped('ShowBannerResult', warnings.value).replace(/\n$/, ''));
      } catch { /* getLog needs privileges the user may not have */ }
    }
    lines.push('');
    return lines.join('\n');
  };

  // ------------------------------------------------------------------
  // Tab completion
  // ------------------------------------------------------------------

  let collectionNameCache = { at: 0, db: null, names: [] };

  function collectionNames() {
    const db = msh.currentDb;
    if (db === null) return [];
    const now = Date.now();
    if (collectionNameCache.db !== db._name || now - collectionNameCache.at > 5000) {
      let names = [];
      try {
        names = db.getCollectionNames();
      } catch { /* completion must never fail loudly */ }
      collectionNameCache = { at: now, db: db._name, names };
    }
    return collectionNameCache.names;
  }

  function propertyNames(object) {
    const names = new Set();
    for (let o = object; o !== null && o !== undefined && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (key !== 'constructor' && !key.startsWith('_') && /^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
      }
    }
    return Array.from(names);
  }

  // What a method call evaluates to, for completing `db.coll.find().<tab>`.
  const RETURN_TYPES = {
    find: () => msh.Cursor.prototype,
    aggregate: () => msh.AggregationCursor.prototype,
    explain: () => msh.Explainable.prototype,
    watch: () => msh.ChangeStreamCursor.prototype,
    getSiblingDB: () => msh.Database.prototype,
    getDB: () => msh.Database.prototype,
    getDatabase: () => msh.Database.prototype,
    getCollection: () => msh.Collection.prototype,
    getMongo: () => msh.Mongo.prototype,
    startSession: () => msh.Session.prototype,
    initializeOrderedBulkOp: () => msh.Bulk.prototype,
    initializeUnorderedBulkOp: () => msh.Bulk.prototype,
    getPlanCache: () => msh.PlanCache.prototype,
  };
  const CURSOR_CHAIN = new Set([
    'sort', 'limit', 'skip', 'projection', 'hint', 'batchSize', 'collation', 'comment', 'maxTimeMS', 'min', 'max',
    'readPref', 'readConcern', 'returnKey', 'showRecordId', 'allowDiskUse', 'allowPartialResults', 'noCursorTimeout',
    'tailable', 'pretty', 'map', 'addOption', 'maxAwaitTimeMS', 'oplogReplay',
  ]);

  const KEYWORDS = [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'false', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  ];

  /** Returns [start, candidates] for the text before the cursor. */
  msh.complete = function (line) {
    const none = [line.length, []];
    let match;

    if ((match = /^\s*use\s+(\S*)$/.exec(line))) {
      let names = [];
      try {
        names = requireMongo().getDBNames();
      } catch { /* not connected or not authorised */ }
      return [line.length - match[1].length, names.filter((n) => n.startsWith(match[1])).sort()];
    }
    if ((match = /^\s*show\s+(\S*)$/.exec(line))) {
      return [line.length - match[1].length, SHOW_TOPICS.filter((t) => t.startsWith(match[1]))];
    }

    match = /(?:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|(\)))?\.([\w$]*)$/.exec(line);
    if (match) {
      const [, chain, call, partial] = match;
      const start = line.length - partial.length;
      let target = null;
      let extra = [];
      if (call) {
        // Completing after a call: look at the method name before its parens.
        const before = line.slice(0, match.index + 1);
        let depth = 0;
        let open = -1;
        for (let i = before.length - 1; i >= 0; i--) {
          if (before[i] === ')') depth++;
          else if (before[i] === '(') {
            depth--;
            if (depth === 0) { open = i; break; }
          }
        }
        const method = open === -1 ? null : /([A-Za-z_$][\w$]*)$/.exec(before.slice(0, open));
        if (method) {
          if (RETURN_TYPES[method[1]]) target = RETURN_TYPES[method[1]]();
          else if (CURSOR_CHAIN.has(method[1])) target = msh.Cursor.prototype;
        }
      } else if (chain) {
        const parts = chain.split('.');
        try {
          target = parts[0] === 'db' ? msh.currentDb : g[parts[0]];
          for (const part of parts.slice(1)) {
            if (target === null || target === undefined) break;
            target = target[part];
          }
        } catch {
          target = null;
        }
        if (target !== null && target !== undefined && msh.typeOf(target) === 'Database') {
          extra = collectionNames().filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
        }
      }
      if (target === null || target === undefined) return none;
      const names = new Set([...propertyNames(Object(target)), ...extra]);
      return [start, Array.from(names).filter((n) => n.startsWith(partial)).sort()];
    }

    match = /([A-Za-z_$][\w$]*)$/.exec(line);
    if (match) {
      const partial = match[1];
      const globals = new Set([...Object.getOwnPropertyNames(g), ...KEYWORDS]);
      if (/^\s*[A-Za-z_$][\w$]*$/.test(line)) for (const name of Object.keys(DIRECT_COMMANDS)) globals.add(name);
      const names = Array.from(globals).filter((n) => n.startsWith(partial) && !n.startsWith('__') && /^[A-Za-z_$][\w$]*$/.test(n));
      return [line.length - partial.length, names.sort()];
    }
    return none;
  };

})(globalThis);
