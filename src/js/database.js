// The Database class (`db`). Unknown property names resolve to collections,
// so `db.users` and `db.getCollection('users')` are the same object.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const { asPrintable, shellApiType, inspectCustom } = msh.symbols;
  const { MongoshDeprecatedError, MongoshInvalidInputError, MongoshRuntimeError, MongoshUnimplementedError } = msh.errors;

  const isValidCollectionName = (name) => !!name && !/[$\0]/.test(name);
  // "$" is allowed: `$external` is the database of X.509 and LDAP users.
  const isValidDatabaseName = (name) => typeof name === 'string' && name.length > 0 && !/[/\\. "\0]/.test(name);

  /** A result printed as "heading\nvalue" blocks separated by "---". */
  class CommandResult {
    constructor(type, value) {
      this.type = type;
      this.value = value;
    }
    [asPrintable]() {
      return this.value;
    }
    get [shellApiType]() {
      return this.type;
    }
    [inspectCustom](depth, options, inspect) {
      return inspect(this.value, options);
    }
    toJSON() {
      return this.value;
    }
  }
  msh.CommandResult = CommandResult;

  /** Wrap a collection so `db.a.b` is the collection "a.b". */
  function collectionProxy(collection) {
    return new Proxy(collection, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || prop.startsWith('_') || !isValidCollectionName(prop) || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return target._database.getCollection(`${target._name}.${prop}`);
      },
    });
  }

  function assertWriteConcernLike(doc, name) {
    if (doc !== undefined && (doc === null || typeof doc !== 'object')) {
      throw msh.invalidInput(`Expected ${name} to be an object`);
    }
  }

  class Database {
    constructor(mongo, name, session) {
      msh.hide(this, { _mongo: mongo, _name: name, _session: session, _collections: Object.create(null) });
      const proxy = new Proxy(this, {
        get(target, prop, receiver) {
          // util.inspect-style array detection must not create a collection.
          if (prop === 'splice') return undefined;
          if (typeof prop !== 'string' || prop.startsWith('_') || !isValidCollectionName(prop) || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return target.getCollection(prop);
        },
      });
      msh.hide(this, { _proxy: proxy });
      return proxy;
    }

    [asPrintable]() {
      return this._name;
    }

    _sessionHandle() {
      const session = this._session;
      if (!session) return undefined;
      if (session._ended) throw new msh.errors.MongoExpiredSessionError('Use of expired sessions is not permitted');
      return session._handle;
    }

    _inTransaction() {
      return !!(this._session && this._session._inTransaction);
    }

    _run(cmd, opts) {
      const options = Object.assign({}, opts);
      const handle = this._sessionHandle();
      if (handle !== undefined) options.session = handle;
      return this._mongo._run(this._name, cmd, options);
    }

    _adminRun(cmd, opts) {
      const options = Object.assign({}, opts);
      const handle = this._sessionHandle();
      if (handle !== undefined) options.session = handle;
      return this._mongo._run('admin', cmd, options);
    }

    _withWriteConcern(cmd, writeConcern) {
      assertWriteConcernLike(writeConcern, 'writeConcern');
      if (writeConcern !== undefined) cmd.writeConcern = writeConcern;
      return cmd;
    }

    // ---- basics -----------------------------------------------------------

    getMongo() {
      return this._mongo;
    }

    getName() {
      return this._name;
    }

    getSiblingDB(db) {
      msh.assertArgs([db], [['string']], 'Database.getSiblingDB');
      if (this._session) return this._session.getDatabase(db);
      return this._mongo.getDB(db);
    }

    getCollection(coll) {
      // "getColl" is how mongosh words this one.
      msh.assertArgs([coll], [['string']], 'Database.getColl');
      if (!isValidCollectionName(coll)) throw msh.invalidInput(`Invalid collection name: ${coll}`);
      if (!(coll in this._collections)) {
        this._collections[coll] = collectionProxy(new msh.Collection(this._mongo, this._proxy, coll));
      }
      return this._collections[coll];
    }

    _listCollections(filter, options) {
      const cmd = Object.assign({ listCollections: 1, filter: filter || {}, cursor: {} }, msh.pick(options, ['nameOnly', 'authorizedCollections', 'comment']));
      return new msh.RunCommandCursor(this._mongo, this._proxy, cmd).toArray();
    }

    getCollectionNames() {
      return this._listCollections({}, { nameOnly: true }).map((info) => info.name);
    }

    getCollectionInfos(filter, options) {
      return this._listCollections(filter || {}, options || {});
    }

    /** Sorted names with a badge for views and time-series collections. */
    _getCollectionNamesWithTypes() {
      const infos = this._listCollections({}, { nameOnly: true });
      const badges = { timeseries: '[time-series]', view: '[view]' };
      return infos
        .sort((a, b) => msh.localeCompare(a.name, b.name))
        .map((info) => ({ name: info.name, badge: badges[info.type] || '' }));
    }

    runCommand(cmd, options) {
      msh.required([cmd], 1, 'Database.runCommand');
      if (typeof cmd === 'string') cmd = { [cmd]: 1 };
      return this._run(cmd, options && options.readPreference ? { readPreference: msh.normalizeReadPreference(options.readPreference) } : undefined);
    }

    adminCommand(cmd) {
      msh.required([cmd], 1, 'Database.adminCommand');
      if (typeof cmd === 'string') cmd = { [cmd]: 1 };
      return this._adminRun(cmd);
    }

    aggregate(pipelineOrStage, ...optionsOrStages) {
      let pipeline, options;
      if (Array.isArray(pipelineOrStage)) {
        pipeline = pipelineOrStage;
        options = optionsOrStages[0] || {};
      } else {
        pipeline = [pipelineOrStage, ...optionsOrStages].filter((stage) => stage !== undefined);
        options = {};
      }
      const { explain, ...rest } = options;
      const cursor = new msh.AggregationCursor(this._mongo, this._proxy, null, pipeline, rest);
      if (explain) return cursor.explain(explain);
      if (cursor._hasWriteStage()) cursor.hasNext();
      return (msh.currentCursor = cursor);
    }

    dropDatabase(writeConcern) {
      const reply = this._run(this._withWriteConcern({ dropDatabase: 1 }, writeConcern));
      return { ok: reply.ok, dropped: this._name };
    }

    createCollection(name, options) {
      msh.assertArgs([name], [['string']], 'Database.createCollection');
      const opts = Object.assign({}, options);
      if (opts.timeseries) {
        for (const required of ['timeField']) {
          if (!opts.timeseries[required]) throw msh.invalidInput(`Missing required property: "timeseries.${required}"`);
        }
      }
      if (opts.clusteredIndex) {
        for (const required of ['key', 'unique']) {
          if (opts.clusteredIndex[required] === undefined) throw msh.invalidInput(`Missing required property: "clusteredIndex.${required}"`);
        }
      }
      this._run(Object.assign({ create: name }, opts));
      return { ok: 1 };
    }

    createView(name, source, pipeline, options) {
      msh.required([name, source, pipeline], 3, 'Database.createView');
      if (typeof name !== 'string' || typeof source !== 'string') throw msh.invalidInput('createView requires string names for the view and its source');
      const cmd = { create: name, viewOn: source, pipeline };
      if (options && options.collation) cmd.collation = options.collation;
      this._run(cmd);
      return { ok: 1 };
    }

    createEncryptedCollection() {
      throw new MongoshUnimplementedError('Client-side field level encryption is not available in mongo-sh', 'COMMON-90002');
    }

    // ---- users ------------------------------------------------------------

    createUser(user, writeConcern) {
      msh.required([user], 1, 'Database.createUser');
      for (const key of ['user', 'roles']) {
        if (user[key] === undefined) throw msh.invalidInput(`Missing required property: "${key}"`);
      }
      if (this._name !== '$external' && user.pwd === undefined) throw msh.invalidInput('Missing required property: "pwd"');
      if (user.createUser) throw msh.invalidInput('Cannot set createUser field in helper method');
      const { user: name, ...rest } = user;
      return this._run(this._withWriteConcern(Object.assign({ createUser: name }, rest), writeConcern));
    }

    updateUser(username, userDoc, writeConcern) {
      msh.required([username, userDoc], 2, 'Database.updateUser');
      if (userDoc.passwordDigestor && userDoc.passwordDigestor !== 'server' && userDoc.passwordDigestor !== 'client') {
        throw msh.invalidInput(`Invalid field: passwordDigestor must be 'client' or 'server', got ${userDoc.passwordDigestor}`);
      }
      return this._run(this._withWriteConcern(Object.assign({ updateUser: username }, userDoc), writeConcern));
    }

    changeUserPassword(username, password, writeConcern) {
      msh.required([username, password], 2, 'Database.changeUserPassword');
      return this._run(this._withWriteConcern({ updateUser: username, pwd: password }, writeConcern));
    }

    logout() {
      this._mongo._reconnect({ username: null, password: null });
      return { ok: 1 };
    }

    dropUser(username, writeConcern) {
      msh.required([username], 1, 'Database.dropUser');
      return this._run(this._withWriteConcern({ dropUser: username }, writeConcern));
    }

    dropAllUsers(writeConcern) {
      return this._run(this._withWriteConcern({ dropAllUsersFromDatabase: 1 }, writeConcern));
    }

    auth(...args) {
      let authDoc;
      if (args.length === 1) {
        if (typeof args[0] === 'string') {
          authDoc = { user: args[0], pwd: msh.native.passwordPrompt() };
        } else {
          authDoc = Object.assign({}, args[0]);
          if (authDoc.pwd === undefined && authDoc.mechanism === undefined) authDoc.pwd = msh.native.passwordPrompt();
        }
      } else if (args.length === 2) {
        authDoc = { user: args[0], pwd: args[1] };
      } else {
        throw msh.invalidInput('auth expects (username), (username, password), or ({ user: username, pwd: password })');
      }
      if (!authDoc.user) throw msh.invalidInput('auth expects user document with at least \'user\' and \'pwd\' fields');
      if ('digestPassword' in authDoc) throw new MongoshUnimplementedError('digestPassword is not supported for authentication.', 'COMMON-90002');
      this._mongo._reconnect({
        username: authDoc.user,
        password: authDoc.pwd,
        authSource: authDoc.authDb || this._name,
        authMechanism: authDoc.mechanism,
      });
      return { ok: 1 };
    }

    grantRolesToUser(username, roles, writeConcern) {
      msh.required([username, roles], 2, 'Database.grantRolesToUser');
      return this._run(this._withWriteConcern({ grantRolesToUser: username, roles }, writeConcern));
    }

    revokeRolesFromUser(username, roles, writeConcern) {
      msh.required([username, roles], 2, 'Database.revokeRolesFromUser');
      return this._run(this._withWriteConcern({ revokeRolesFromUser: username, roles }, writeConcern));
    }

    getUser(username, options) {
      msh.required([username], 1, 'Database.getUser');
      const reply = this._run(Object.assign({ usersInfo: { user: username, db: this._name } }, options));
      if (!reply.users) return null;
      return reply.users.find((user) => user.user === username) || null;
    }

    getUsers(options) {
      return this._run(Object.assign({ usersInfo: 1 }, options));
    }

    // ---- roles ------------------------------------------------------------

    createRole(role, writeConcern) {
      msh.required([role], 1, 'Database.createRole');
      for (const key of ['role', 'privileges', 'roles']) {
        if (role[key] === undefined) throw msh.invalidInput(`Missing required property: "${key}"`);
      }
      if (role.createRole) throw msh.invalidInput('Cannot set createRole field in helper method');
      const { role: name, ...rest } = role;
      return this._run(this._withWriteConcern(Object.assign({ createRole: name }, rest), writeConcern));
    }

    updateRole(rolename, roleDoc, writeConcern) {
      msh.required([rolename, roleDoc], 2, 'Database.updateRole');
      return this._run(this._withWriteConcern(Object.assign({ updateRole: rolename }, roleDoc), writeConcern));
    }

    dropRole(rolename, writeConcern) {
      msh.required([rolename], 1, 'Database.dropRole');
      return this._run(this._withWriteConcern({ dropRole: rolename }, writeConcern));
    }

    dropAllRoles(writeConcern) {
      return this._run(this._withWriteConcern({ dropAllRolesFromDatabase: 1 }, writeConcern));
    }

    grantRolesToRole(rolename, roles, writeConcern) {
      msh.required([rolename, roles], 2, 'Database.grantRolesToRole');
      return this._run(this._withWriteConcern({ grantRolesToRole: rolename, roles }, writeConcern));
    }

    revokeRolesFromRole(rolename, roles, writeConcern) {
      msh.required([rolename, roles], 2, 'Database.revokeRolesFromRole');
      return this._run(this._withWriteConcern({ revokeRolesFromRole: rolename, roles }, writeConcern));
    }

    grantPrivilegesToRole(rolename, privileges, writeConcern) {
      msh.required([rolename, privileges], 2, 'Database.grantPrivilegesToRole');
      return this._run(this._withWriteConcern({ grantPrivilegesToRole: rolename, privileges }, writeConcern));
    }

    revokePrivilegesFromRole(rolename, privileges, writeConcern) {
      msh.required([rolename, privileges], 2, 'Database.revokePrivilegesFromRole');
      return this._run(this._withWriteConcern({ revokePrivilegesFromRole: rolename, privileges }, writeConcern));
    }

    getRole(rolename, options) {
      msh.required([rolename], 1, 'Database.getRole');
      const reply = this._run(Object.assign({ rolesInfo: { role: rolename, db: this._name } }, options));
      if (!reply.roles) return null;
      return reply.roles.find((role) => role.role === rolename) || null;
    }

    getRoles(options) {
      return this._run(Object.assign({ rolesInfo: 1 }, options));
    }

    // ---- server administration ----------------------------------------------

    _currentOperations(opts) {
      const legacy = typeof opts === 'boolean'
        ? { $all: opts, $ownOps: false }
        : { $all: !!opts.$all, $ownOps: !!opts.$ownOps };
      const pipeline = [{ $currentOp: { allUsers: !legacy.$ownOps, idleConnections: legacy.$all, truncateOps: false } }];
      if (typeof opts === 'object') {
        const match = {};
        for (const key of Object.keys(opts)) {
          if (key !== '$ownOps' && key !== '$all') match[key] = opts[key];
        }
        pipeline.push({ $match: match });
      }
      const admin = this.getSiblingDB('admin');
      const run = () => new msh.AggregationCursor(this._mongo, admin, null, pipeline, { readPreference: { mode: 'primaryPreferred' } }).toArray();
      try {
        return run();
      } catch (error) {
        if (error && error.codeName === 'FailedToParse' && /unrecognized option 'truncateOps'/.test(error.errmsg || '')) {
          delete pipeline[0].$currentOp.truncateOps;
          return run();
        }
        throw error;
      }
    }

    currentOp(opts) {
      return { inprog: this._currentOperations(opts === undefined ? {} : opts), ok: 1 };
    }

    killOp(opId) {
      return this._adminRun({ killOp: 1, op: opId });
    }

    shutdownServer(opts) {
      return this._adminRun(Object.assign({ shutdown: 1 }, opts));
    }

    fsyncLock() {
      return this._adminRun({ fsync: 1, lock: true });
    }

    fsyncUnlock() {
      return this._adminRun({ fsyncUnlock: 1 });
    }

    version() {
      const info = this._adminRun({ buildInfo: 1 });
      if (!info || info.version === undefined) throw new MongoshRuntimeError(`Error running command serverBuildInfo ${info ? info.errmsg || '' : ''}`, 'COMMON-10004');
      return info.version;
    }

    serverBits() {
      const info = this._adminRun({ buildInfo: 1 });
      if (!info || info.bits === undefined) throw new MongoshRuntimeError(`Error running command serverBuildInfo ${info ? info.errmsg || '' : ''}`, 'COMMON-10004');
      return info.bits;
    }

    isMaster() {
      return this._run({ isMaster: 1 });
    }

    hello() {
      try {
        return this._run({ hello: 1 });
      } catch (error) {
        if (error && error.codeName === 'CommandNotFound') {
          const reply = this.isMaster();
          delete reply.ismaster;
          return reply;
        }
        throw error;
      }
    }

    serverBuildInfo() {
      return this._adminRun({ buildInfo: 1 });
    }

    serverStatus(opts) {
      return this._adminRun(Object.assign({ serverStatus: 1 }, opts));
    }

    stats(scaleOrOptions) {
      const options = typeof scaleOrOptions === 'number' ? { scale: scaleOrOptions } : Object.assign({}, scaleOrOptions);
      return this._run(Object.assign({ dbStats: 1, scale: options.scale === undefined ? 1 : options.scale }, msh.pick(options, ['freeStorage'])));
    }

    hostInfo() {
      return this._adminRun({ hostInfo: 1 });
    }

    serverCmdLineOpts() {
      return this._adminRun({ getCmdLineOpts: 1 });
    }

    rotateCertificates(message) {
      return this._adminRun(msh.compact({ rotateCertificates: 1, message }));
    }

    printCollectionStats(scale) {
      if (scale === undefined) scale = 1;
      if (typeof scale !== 'number' || scale < 1) throw msh.invalidInput(`scale has to be a number >=1, got ${scale}`);
      const result = {};
      for (const name of this.getCollectionNames()) result[name] = this.getCollection(name).stats(scale);
      return new CommandResult('StatsResult', result);
    }

    getProfilingStatus() {
      return this._run({ profile: -1 });
    }

    setProfilingLevel(level, opts) {
      msh.required([level], 1, 'Database.setProfilingLevel');
      if (level < 0 || level > 2) throw msh.invalidInput(`Input level ${level} is out of range [0..2]`);
      const options = typeof opts === 'number' ? { slowms: opts } : Object.assign({}, opts);
      return this._run(Object.assign({ profile: level }, options));
    }

    setLogLevel(logLevel, component) {
      msh.required([logLevel], 1, 'Database.setLogLevel');
      let names = [];
      if (typeof component === 'string') names = component.split('.');
      else if (component !== undefined) throw msh.invalidInput(`setLogLevel component must be a string: got ${typeof component}`);
      let doc = { verbosity: logLevel };
      while (names.length) doc = { [names.pop()]: doc };
      return this._adminRun({ setParameter: 1, logComponentVerbosity: doc });
    }

    getLogComponents() {
      const reply = this._adminRun({ getParameter: 1, logComponentVerbosity: 1 });
      if (!reply || reply.logComponentVerbosity === undefined) throw new MongoshRuntimeError(`Error running command  ${reply ? reply.errmsg || '' : ''}`, 'COMMON-10004');
      return reply.logComponentVerbosity;
    }

    commandHelp(name) {
      msh.required([name], 1, 'Database.commandHelp');
      const reply = this._run({ [name]: 1, help: true });
      if (!reply || reply.help === undefined) throw new MongoshRuntimeError(`Error running command commandHelp ${reply ? reply.errmsg || '' : ''}`, 'COMMON-10004');
      return reply.help;
    }

    listCommands() {
      const reply = this._run({ listCommands: 1 });
      if (!reply || reply.commands === undefined) throw new MongoshRuntimeError(`Error running command listCommands ${reply ? reply.errmsg || '' : ''}`, 'COMMON-10004');
      for (const name of Object.keys(reply.commands)) {
        const command = reply.commands[name];
        // Older servers report slaveOk; show one name for both.
        if (command.slaveOk !== undefined) {
          if (command.secondaryOk === undefined) command.secondaryOk = command.slaveOk;
          delete command.slaveOk;
        }
        if (command.slaveOverrideOk !== undefined) {
          if (command.secondaryOverrideOk === undefined) command.secondaryOverrideOk = command.slaveOverrideOk;
          delete command.slaveOverrideOk;
        }
      }
      return new CommandResult('ListCommandsResult', reply.commands);
    }

    getLastErrorObj(w, wTimeout, j) {
      msh.deprecated('Database.getLastErrorObj() is deprecated and will be removed in the future.');
      const cmd = { getlasterror: 1 };
      if (w) cmd.w = w;
      if (wTimeout) cmd.wtimeout = wTimeout;
      if (j !== undefined) cmd.j = j;
      try {
        return this._run(cmd);
      } catch (error) {
        return { ok: error.ok, errmsg: error.errmsg, code: error.code, codeName: error.codeName };
      }
    }

    getLastError(w, wTimeout) {
      msh.deprecated('Database.getLastError() is deprecated and will be removed in the future.');
      const cmd = { getlasterror: 1 };
      if (w) cmd.w = w;
      if (wTimeout) cmd.wtimeout = wTimeout;
      try {
        const reply = this._run(cmd);
        return reply.err || null;
      } catch (error) {
        return error.errmsg || null;
      }
    }

    // ---- replication and sharding helpers --------------------------------

    getReplicationInfo() {
      const local = this.getSiblingDB('local');
      const result = {};
      if (!local.getCollectionNames().includes('oplog.rs')) {
        throw new MongoshInvalidInputError('Replication not detected. No oplog.rs collection found', 'SHAPI-10002');
      }
      const oplog = local.getCollection('oplog.rs');
      const stats = oplog.stats();
      if (!stats || !stats.maxSize) {
        throw new MongoshRuntimeError(`Could not get stats for local.oplog.rs collection. collstats returned ${JSON.stringify(stats)}`, 'SHAPI-10004');
      }
      result.configuredLogSizeMB = stats.maxSize / (1024 * 1024);
      result.logSizeMB = Math.max(stats.maxSize, stats.size) / (1024 * 1024);
      result.usedMB = Math.ceil((stats.size / (1024 * 1024)) * 100) / 100;
      const first = oplog.find().sort({ $natural: 1 }).limit(1).tryNext();
      const last = oplog.find().sort({ $natural: -1 }).limit(1).tryNext();
      if (first === null || last === null) {
        throw new MongoshRuntimeError('objects not found in local.oplog.$main -- is this a new and empty db instance?', 'SHAPI-10004');
      }
      const seconds = (ts) => (ts && typeof ts.getHighBits === 'function' ? ts.getHighBits() >>> 0 : NaN);
      const tFirst = seconds(first.ts);
      const tLast = seconds(last.ts);
      if (!Number.isNaN(tFirst) && !Number.isNaN(tLast)) {
        result.timeDiff = tLast - tFirst;
        result.timeDiffHours = Math.round(result.timeDiff / 36) / 100;
        result.tFirst = new Date(tFirst * 1000).toString();
        result.tLast = new Date(tLast * 1000).toString();
        result.now = Date();
      } else {
        result.errmsg = 'ts element not found in oplog objects';
      }
      return result;
    }

    printReplicationInfo() {
      let info;
      try {
        info = this.getReplicationInfo();
      } catch (error) {
        const hello = this._run({ isMaster: 1 });
        if (hello.arbiterOnly) {
          return new CommandResult('StatsResult', { message: 'cannot provide replication status from an arbiter' });
        }
        if (!hello.ismaster) {
          const secondary = this.printSecondaryReplicationInfo();
          return new CommandResult('StatsResult', Object.assign({ message: 'this is a secondary, printing secondary replication info.' }, secondary.value));
        }
        throw error;
      }
      return new CommandResult('StatsResult', {
        'actual oplog size': `${info.logSizeMB} MB`,
        'configured oplog size': `${info.configuredLogSizeMB} MB`,
        'log length start to end': `${info.timeDiff}secs (${info.timeDiffHours}hrs)`,
        'oplog first event time': info.tFirst,
        'oplog last event time': info.tLast,
        now: info.now,
      });
    }

    printSecondaryReplicationInfo() {
      let startOptimeDate = null;
      const local = this.getSiblingDB('local');
      const result = {};
      if (!local.getCollection('system.replset').findOne()) {
        throw new MongoshInvalidInputError('local.system.replset is empty. Are you connected to a replica set?', 'SHAPI-10002');
      }
      const status = this._adminRun({ replSetGetStatus: 1 });
      // The primary's optime is the reference point for every other member.
      for (const member of status.members) {
        if (member.state === 1) {
          startOptimeDate = member.optimeDate;
          break;
        }
      }
      for (const node of status.members) {
        const nodeResult = {};
        if (node === null || node === undefined) {
          throw new MongoshRuntimeError('Member returned from command replSetGetStatus is null', 'SHAPI-10004');
        }
        if (node.state === 1 || node.state === 7) continue;
        if (node.optime && node.health !== 0) {
          if (startOptimeDate === null || startOptimeDate === undefined) {
            throw new MongoshRuntimeError(`getReplLag startOptimeDate is null`, 'SHAPI-10004');
          }
          if (startOptimeDate) nodeResult.syncedTo = node.optimeDate.toString();
          const ago = (startOptimeDate - node.optimeDate) / 1000;
          const hrs = Math.round(ago / 36) / 100;
          const suffix = startOptimeDate ? 'primary ' : 'freshest member (no primary available at the moment)';
          nodeResult.replLag = `${Math.round(ago)} secs (${hrs} hrs) behind the ${suffix}`;
        } else {
          nodeResult['no replication info, yet.  State'] = node.stateStr;
        }
        result[`source: ${node.name}`] = nodeResult;
      }
      return new CommandResult('StatsResult', result);
    }

    printSlaveReplicationInfo() {
      throw new MongoshDeprecatedError('Method deprecated, use db.printSecondaryReplicationInfo instead', 'COMMON-10003');
    }

    setSecondaryOk() {
      this._mongo.setSecondaryOk();
    }

    printShardingStatus(verbose) {
      msh.warnIfNotMongos(this._mongo);
      const result = msh.getPrintableShardStatus(this.getSiblingDB('config'), verbose);
      return new CommandResult('StatsResult', result);
    }

    watch(pipeline, options) {
      if (pipeline === undefined) pipeline = [];
      else if (!Array.isArray(pipeline)) {
        options = pipeline;
        pipeline = [];
      }
      const cursor = new msh.ChangeStreamCursor(this._mongo, this._proxy, null, pipeline, options || {}, this._name);
      cursor._cursor().start();
      return (msh.currentCursor = cursor);
    }

    sql(sqlString, options) {
      msh.required([sqlString], 1, 'Database.sql');
      const cursor = new msh.AggregationCursor(this._mongo, this._proxy, null, [
        { $sql: { statement: sqlString, format: 'jdbc', dialect: 'mongosql', formatVersion: 1 } },
      ], options || {});
      try {
        cursor.hasNext();
      } catch (error) {
        if (error && error.code === 40324) {
          throw new msh.errors.MongoshCommandFailed('db.sql currently only works with Atlas Data Lake', 'SHAPI-10005');
        }
        throw error;
      }
      return cursor;
    }

    checkMetadataConsistency(options) {
      return new msh.RunCommandCursor(this._mongo, this._proxy, Object.assign({ checkMetadataConsistency: 1 }, options));
    }

    cloneDatabase() {
      throw new MongoshDeprecatedError('`cloneDatabase()` was removed because it was deprecated in MongoDB 4.0', 'COMMON-10003');
    }

    cloneCollection() {
      throw new MongoshDeprecatedError('`cloneCollection()` was removed because it was deprecated in MongoDB 4.0', 'COMMON-10003');
    }

    copyDatabase() {
      throw new MongoshDeprecatedError('`copyDatabase()` was removed because it was deprecated in MongoDB 4.0', 'COMMON-10003');
    }
  }

  msh.describeClass(Database, {
    type: 'Database',
    help: 'Database Class',
    prefix: 'Database',
    docs: `${msh.docs.manual}/js-database`,
    methods: {
      getMongo: 'Returns the connection this database object uses.',
      getName: 'Returns the name of the database.',
      getCollectionNames: 'Returns the names of the collections and views in the database.',
      getCollectionInfos: 'Returns name, type and options for the collections matching a filter.',
      runCommand: 'Runs a command against this database and returns the reply.',
      adminCommand: 'Runs a command against the admin database and returns the reply.',
      aggregate: 'Runs a database-level aggregation pipeline, such as one starting with $currentOp.',
      getSiblingDB: 'Returns another database on the same connection without switching to it.',
      getCollection: 'Returns a collection by name. Needed for names that are not valid identifiers.',
      dropDatabase: 'Drops the database along with its collections.',
      createUser: 'Creates a user in this database.',
      updateUser: "Replaces fields of a user's definition, such as roles or password.",
      changeUserPassword: "Changes a user's password.",
      logout: 'Drops the credentials of the current connection.',
      dropUser: 'Removes a user from this database.',
      dropAllUsers: 'Removes every user defined in this database.',
      auth: 'Authenticates the connection as the given user.',
      grantRolesToUser: 'Adds roles to a user.',
      revokeRolesFromUser: 'Removes roles from a user.',
      getUser: 'Returns the definition of one user, or null.',
      getUsers: 'Returns the definitions of all users in this database.',
      createCollection: 'Creates a collection explicitly, for example a capped or time-series collection.',
      createEncryptedCollection: 'Not available: requires client-side field level encryption.',
      createView: 'Creates a read-only view backed by an aggregation pipeline.',
      createRole: 'Creates a role with the given privileges and inherited roles.',
      updateRole: "Replaces fields of a role's definition.",
      dropRole: 'Removes a user-defined role.',
      dropAllRoles: 'Removes every user-defined role in this database.',
      grantRolesToRole: 'Makes a role inherit from additional roles.',
      revokeRolesFromRole: 'Removes inherited roles from a role.',
      grantPrivilegesToRole: 'Adds privileges to a role.',
      revokePrivilegesFromRole: 'Removes privileges from a role.',
      getRole: 'Returns the definition of one role, or null.',
      getRoles: 'Returns the definitions of the roles in this database.',
      currentOp: 'Lists the operations currently running on the server.',
      killOp: 'Asks the server to stop the operation with the given id.',
      shutdownServer: 'Shuts the server down cleanly. Must be run by an authorised user.',
      fsyncLock: 'Flushes data to disk and blocks writes until fsyncUnlock().',
      fsyncUnlock: 'Releases the lock taken by fsyncLock().',
      version: 'Returns the version of the server.',
      serverBits: 'Returns whether the server is a 32 or 64 bit build.',
      isMaster: 'Legacy form of hello().',
      hello: 'Returns the role of the server in its deployment.',
      serverBuildInfo: 'Returns the build details of the server.',
      serverStatus: 'Returns an overview of the state of the server process.',
      stats: 'Returns storage statistics for the database.',
      hostInfo: 'Returns information about the machine the server runs on.',
      serverCmdLineOpts: 'Returns the options the server was started with.',
      rotateCertificates: 'Reloads the TLS certificates of the server from disk.',
      printCollectionStats: 'Prints the statistics of every collection in the database.',
      getProfilingStatus: 'Returns the current profiler level and thresholds.',
      setProfilingLevel: 'Sets the profiler level (0, 1 or 2) and its options.',
      setLogLevel: 'Sets the log verbosity, optionally for one log component.',
      getLogComponents: 'Returns the verbosity of each log component.',
      commandHelp: 'Returns the help text of a database command.',
      listCommands: 'Lists the commands the server supports.',
      getLastErrorObj: 'Deprecated. Returns the status of the last operation on this connection.',
      getLastError: 'Deprecated. Returns the error message of the last operation, or null.',
      printShardingStatus: 'Prints the sharding configuration and chunk distribution.',
      printSecondaryReplicationInfo: 'Prints how far each secondary lags behind the primary.',
      getReplicationInfo: 'Returns the size and time range of the oplog.',
      printReplicationInfo: 'Prints the size and time range of the oplog.',
      printSlaveReplicationInfo: 'Removed. Use printSecondaryReplicationInfo().',
      setSecondaryOk: 'Deprecated. Allows reads from secondaries on this connection.',
      watch: 'Opens a change stream on every collection of the database.',
      sql: 'Runs a SQL query. Only available on Atlas Data Federation.',
      checkMetadataConsistency: 'Returns a cursor over sharding metadata inconsistencies for the database.',
    },
  });

  Object.assign(msh, { Database, isValidCollectionName, isValidDatabaseName });
})(globalThis);
