// Connections (`Mongo`) and sessions.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const native = msh.native;
  const { asPrintable } = msh.symbols;
  const { MongoshUnimplementedError, MongoshRuntimeError } = msh.errors;

  const READ_PREFERENCE_MODES = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'];

  /** Accepts a mode string or a `{ mode, tags, ... }` document. */
  msh.normalizeReadPreference = function (mode, tagSet, hedgeOptions) {
    let pref;
    if (mode !== null && typeof mode === 'object') {
      pref = { mode: mode.mode || mode.readPreference, tagSet: mode.tagSet || mode.tags || mode.readPreferenceTags, maxStalenessSeconds: mode.maxStalenessSeconds, hedge: mode.hedge };
    } else {
      pref = { mode, tagSet, hedge: hedgeOptions };
    }
    if (!READ_PREFERENCE_MODES.includes(pref.mode)) {
      throw new msh.errors.MongoInvalidArgumentError(`Invalid read preference mode ${JSON.stringify(pref.mode)}`);
    }
    return msh.compact(pref);
  };

  // Plain data holders with the driver's class names and field layout, which
  // is what getReadPref() and getWriteConcern() print.
  class ReadPreference {
    constructor(pref) {
      this.mode = pref.mode;
      this.tags = pref.tagSet;
      this.hedge = pref.hedge;
      this.maxStalenessSeconds = pref.maxStalenessSeconds;
    }
  }
  class WriteConcern {
    constructor(concern) {
      for (const key of Object.keys(concern)) {
        if (key === 'wtimeout' || key === 'wtimeoutMS') continue;
        if (key === 'j' || key === 'journal') continue;
        this[key] = concern[key];
      }
      const wtimeout = concern.wtimeoutMS !== undefined ? concern.wtimeoutMS : concern.wtimeout;
      if (wtimeout !== undefined) {
        this.wtimeout = wtimeout;
        this.wtimeoutMS = wtimeout;
      }
      const journal = concern.journal !== undefined ? concern.journal : concern.j;
      if (journal !== undefined) {
        this.j = journal;
        this.journal = journal;
      }
    }
  }

  function queryParams(uri) {
    const params = {};
    const query = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
    for (const part of query.split('&')) {
      if (!part) continue;
      const at = part.indexOf('=');
      const key = at === -1 ? part : part.slice(0, at);
      let value = at === -1 ? '' : part.slice(at + 1);
      try {
        value = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch { /* keep the raw value */ }
      const lower = key.toLowerCase();
      if (lower in params) params[lower] = [].concat(params[lower], value);
      else params[lower] = value;
    }
    return params;
  }

  class Mongo {
    constructor(uri, fleOptions, otherOptions) {
      if (fleOptions !== undefined && fleOptions !== null) {
        throw new MongoshUnimplementedError('Client-side field level encryption is not available in mongo-sh', 'COMMON-90002');
      }
      const normalized = uri !== null && typeof uri === 'object' && uri.__normalized
        ? uri
        : native.normalizeUri(uri === undefined || uri === null ? '' : String(uri));
      msh.hide(this, {
        _uri: normalized.uri,
        _redactedUri: normalized.redacted,
        _clientId: null,
        _databases: Object.create(null),
        _sessions: [],
        _readPref: undefined,
        _readConcern: undefined,
        _writeConcern: undefined,
        _serverApi: (otherOptions && otherOptions.api) || msh.config.serverApi || undefined,
        _closed: false,
        _helloCache: null,
        _helloAt: 0,
      });
      this._connect();
    }

    [asPrintable]() {
      return this._redactedUri;
    }

    _connect() {
      const info = native.connect(this._uri, msh.compact({ serverApi: this._serverApi }));
      this._clientId = info.id;
      msh.hide(this, { _defaultDatabase: info.defaultDatabase || 'test', _hosts: info.hosts });
      const params = queryParams(this._uri);
      if (typeof params.readpreference === 'string' && params.readpreference !== 'primary') {
        const tags = params.readpreferencetags === undefined ? undefined : [].concat(params.readpreferencetags).map((entry) => {
          const set = {};
          for (const pair of entry.split(',')) {
            if (!pair) continue;
            const [key, value] = pair.split(':');
            set[key] = value;
          }
          return set;
        });
        this._readPref = msh.compact({
          mode: params.readpreference,
          tagSet: tags,
          maxStalenessSeconds: params.maxstalenessseconds === undefined ? undefined : Number(params.maxstalenessseconds),
        });
      }
      if (params.readconcernlevel) this._readConcern = { level: params.readconcernlevel };
      // Fail now, like mongosh, rather than on the first command typed.
      this._run('admin', { ping: 1 }, {});
    }

    /** Swap the underlying client for one with different credentials. */
    _reconnect(changes) {
      const rewritten = native.withCredentials(this._uri, changes.username, changes.password, changes.authSource || null, changes.authMechanism || null);
      const previous = { uri: this._uri, redacted: this._redactedUri, clientId: this._clientId };
      this._uri = rewritten.uri;
      this._redactedUri = rewritten.redacted;
      try {
        this._connect();
      } catch (error) {
        this._uri = previous.uri;
        this._redactedUri = previous.redacted;
        if (this._clientId !== previous.clientId && this._clientId !== null) native.clientClose(this._clientId);
        this._clientId = previous.clientId;
        throw error;
      }
      native.clientClose(previous.clientId);
      this._helloCache = null;
    }

    _assertOpen() {
      if (this._closed) throw new msh.errors.MongoNotConnectedError('Client must be connected before running operations');
    }

    _readPreferenceForReads() {
      return this._readPref && this._readPref.mode !== 'primary' ? this._readPref : undefined;
    }

    /**
     * Run one command. `opts.read` marks commands that follow the connection
     * read preference; everything else goes to the primary.
     */
    _run(dbName, cmd, opts) {
      this._assertOpen();
      const options = {};
      if (opts && opts.session !== undefined) options.session = opts.session;
      const readPreference = (opts && opts.readPreference) || (opts && opts.read ? this._readPreferenceForReads() : undefined);
      if (readPreference) options.readPreference = readPreference;
      if (opts && opts.read && this._readConcern && cmd.readConcern === undefined && options.session === undefined) {
        cmd = Object.assign({}, cmd, { readConcern: this._readConcern });
      }
      return msh.fromServer(native.runCommand(this._clientId, dbName, cmd, options));
    }

    /** `hello`, cached briefly: it feeds the prompt on every line. */
    _hello(maxAgeMs) {
      const now = Date.now();
      if (this._helloCache === null || now - this._helloAt > (maxAgeMs === undefined ? 5000 : maxAgeMs)) {
        try {
          this._helloCache = this._run('admin', { hello: 1 }, {});
        } catch (error) {
          if (!(error && error.codeName === 'CommandNotFound')) throw error;
          this._helloCache = this._run('admin', { isMaster: 1 }, {});
        }
        this._helloAt = now;
      }
      return this._helloCache;
    }

    // ---- public API -------------------------------------------------------

    getDB(db) {
      msh.required([db], 1, 'Mongo.getDB');
      if (typeof db !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof db} instead (Mongo.getDB)`);
      if (!msh.isValidDatabaseName(db)) throw msh.invalidInput(`Invalid database name: ${db}`);
      if (!(db in this._databases)) this._databases[db] = new msh.Database(this, db);
      return this._databases[db];
    }

    getCollection(name) {
      msh.required([name], 1, 'Mongo.getCollection');
      if (typeof name !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof name} instead (Mongo.getCollection)`);
      const dot = name.indexOf('.');
      if (dot <= 0 || dot === name.length - 1) {
        throw msh.invalidInput('Collection must be of the format <db>.<collection>');
      }
      return this.getDB(name.slice(0, dot)).getCollection(name.slice(dot + 1));
    }

    getURI() {
      return this._uri;
    }

    use(db) {
      msh.required([db], 1, 'Mongo.use');
      if (typeof db !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof db} instead (Mongo.use)`);
      const previous = msh.currentDb;
      msh.setCurrentDb(this.getDB(db));
      return previous && previous._name === db && previous._mongo === this ? `already on db ${db}` : `switched to db ${db}`;
    }

    show(cmd, arg) {
      return msh.show(this, cmd, arg);
    }

    getDBs(options) {
      return this._run('admin', Object.assign({ listDatabases: 1 }, options), { read: true });
    }

    getDBNames(options) {
      return this.getDBs(options).databases.map((db) => db.name);
    }

    getReadPrefMode() {
      return this._readPref ? this._readPref.mode : 'primary';
    }

    getReadPrefTagSet() {
      return this._readPref ? this._readPref.tagSet : undefined;
    }

    getReadPref() {
      return new ReadPreference(this._readPref || { mode: 'primary' });
    }

    setReadPref(mode, tagSet, hedgeOptions) {
      msh.required([mode], 1, 'Mongo.setReadPref');
      this._readPref = msh.normalizeReadPreference(mode, tagSet, hedgeOptions);
    }

    getReadConcern() {
      return this._readConcern ? this._readConcern.level : undefined;
    }

    setReadConcern(level) {
      msh.required([level], 1, 'Mongo.setReadConcern');
      this._readConcern = { level };
    }

    getWriteConcern() {
      return this._writeConcern ? new WriteConcern(this._writeConcern) : undefined;
    }

    setWriteConcern(concern, wtimeoutMS, jValue) {
      msh.required([concern], 1, 'Mongo.setWriteConcern');
      if (typeof concern === 'object' && concern !== null) {
        if (wtimeoutMS !== undefined || jValue !== undefined) {
          throw msh.invalidInput('If concern is given as an object no other arguments must be specified');
        }
        this._writeConcern = concern;
      } else {
        this._writeConcern = msh.compact({ w: concern, wtimeout: wtimeoutMS, j: jValue });
      }
    }

    setSecondaryOk() {
      msh.println('Setting read preference from "primary" to "primaryPreferred"');
      if (!this._readPref || this._readPref.mode === 'primary') this._readPref = { mode: 'primaryPreferred' };
    }

    setSlaveOk() {
      this.setSecondaryOk();
    }

    setCausalConsistency() {
      throw new MongoshUnimplementedError('It is not possible to set causal consistency for an entire connection due to the driver, use startSession({causalConsistency: <>}) instead.', 'COMMON-90002');
    }

    isCausalConsistency() {
      throw new MongoshUnimplementedError('Causal consistency for drivers is set via Mongo.startSession and can be checked via session.getOptions. The default value is true', 'COMMON-90002');
    }

    startSession(options) {
      return new Session(this, options || {});
    }

    watch(pipeline, options) {
      if (pipeline === undefined) pipeline = [];
      else if (!Array.isArray(pipeline)) {
        options = pipeline;
        pipeline = [];
      }
      const cursor = new msh.ChangeStreamCursor(this, this.getDB('admin'), null, pipeline, Object.assign({ allChangesForCluster: true }, options), this._redactedUri);
      cursor._cursor().start();
      return cursor;
    }

    bulkWrite(models, options) {
      msh.required([models], 1, 'Mongo.bulkWrite');
      const namespaces = [];
      const nsIndex = (ns) => {
        let index = namespaces.indexOf(ns);
        if (index === -1) index = namespaces.push(ns) - 1;
        return index;
      };
      const insertedIds = {};
      const ops = models.map((model, i) => {
        const index = nsIndex(model.namespace);
        const common = msh.pick(model, ['collation', 'hint', 'arrayFilters', 'upsert', 'sort']);
        switch (model.name) {
          case 'insertOne': {
            if (model.document._id === undefined) model.document._id = new msh.bson.ObjectId();
            insertedIds[i] = model.document._id;
            return { insert: index, document: model.document };
          }
          case 'updateOne': return Object.assign({ update: index, filter: model.filter, updateMods: model.update, multi: false }, common);
          case 'updateMany': return Object.assign({ update: index, filter: model.filter, updateMods: model.update, multi: true }, common);
          case 'replaceOne': return Object.assign({ update: index, filter: model.filter, updateMods: model.replacement, multi: false }, common);
          case 'deleteOne': return Object.assign({ delete: index, filter: model.filter, multi: false }, msh.pick(model, ['collation', 'hint']));
          case 'deleteMany': return Object.assign({ delete: index, filter: model.filter, multi: true }, msh.pick(model, ['collation', 'hint']));
          default: throw msh.invalidInput(`Unknown bulkWrite operation ${JSON.stringify(model.name)}`);
        }
      });
      const opts = options || {};
      const cmd = Object.assign(
        { bulkWrite: 1, ops, nsInfo: namespaces.map((ns) => ({ ns })), errorsOnly: !opts.verboseResults, ordered: opts.ordered !== false },
        msh.pick(opts, ['bypassDocumentValidation', 'comment', 'let', 'writeConcern']),
      );
      const reply = this._run('admin', cmd, {});
      const result = {
        acknowledged: true,
        insertedCount: reply.nInserted,
        matchedCount: reply.nMatched,
        modifiedCount: reply.nModified,
        deletedCount: reply.nDeleted,
        upsertedCount: reply.nUpserted,
      };
      const first = (reply.cursor && reply.cursor.firstBatch) || [];
      const failed = first.find((item) => item.ok === 0);
      if (failed) throw new msh.errors.MongoServerError(failed.errmsg, failed);
      if (opts.verboseResults) {
        result.insertResults = {};
        result.updateResults = {};
        result.deleteResults = {};
        for (const item of first) {
          const model = models[item.idx];
          if (model.name === 'insertOne') result.insertResults[item.idx] = { insertedId: insertedIds[item.idx] };
          else if (model.name.startsWith('delete')) result.deleteResults[item.idx] = { deletedCount: item.n };
          else result.updateResults[item.idx] = msh.compact({ matchedCount: item.n, modifiedCount: item.nModified, upsertedId: item.upserted ? item.upserted._id : undefined, didUpsert: !!item.upserted });
        }
      }
      return result;
    }

    convertShardKeyToHashed(value) {
      const pipeline = [{ $limit: 1 }, { $project: { _id: { $toHashedIndexKey: { $literal: value } } } }];
      const admin = this.getDB('admin');
      const approaches = [
        () => admin.aggregate([{ $documents: [{}] }, ...pipeline]),
        () => admin.getCollection('system.version').aggregate(pipeline),
        () => this.getDB('local').getCollection('oplog.rs').aggregate(pipeline),
      ];
      for (const approach of approaches) {
        let result;
        try {
          result = approach().next();
        } catch {
          continue;
        }
        if (result) return result._id;
      }
      throw new MongoshRuntimeError('Could not find a suitable way to run convertShardKeyToHashed() -- tried $documents and aggregating on admin.system.version and local.oplog.rs', 'COMMON-10004');
    }

    getKeyVault() {
      throw new MongoshUnimplementedError('Client-side field level encryption is not available in mongo-sh', 'COMMON-90002');
    }

    getClientEncryption() {
      throw new MongoshUnimplementedError('Client-side field level encryption is not available in mongo-sh', 'COMMON-90002');
    }

    close() {
      if (this._closed) return;
      for (const session of this._sessions.slice()) session.endSession();
      native.clientClose(this._clientId);
      this._closed = true;
    }
  }

  msh.describeClass(Mongo, {
    type: 'Mongo',
    help: 'The Mongo Class. Represents a connection to a server',
    prefix: 'Mongo',
    docs: `${msh.docs.manual}/js-connection`,
    methods: {
      getDB: 'Returns a database on this connection.',
      getCollection: 'Returns a collection from a "database.collection" namespace string.',
      getURI: 'Returns the connection string of this connection.',
      getDBs: 'Returns the listDatabases reply: every database with its size on disk.',
      bulkWrite: 'Runs write operations across several collections in one command (MongoDB 8.0+).',
      getDBNames: 'Returns the names of all databases.',
      close: 'Closes the connection and ends its sessions.',
      getReadPrefMode: 'Returns the read preference mode of the connection.',
      getReadPrefTagSet: 'Returns the read preference tag set of the connection.',
      getReadPref: 'Returns the read preference of the connection.',
      setReadPref: 'Sets the read preference used for reads on this connection.',
      getReadConcern: 'Returns the read concern level of the connection.',
      setReadConcern: 'Sets the read concern level used for reads on this connection.',
      getWriteConcern: 'Returns the default write concern of the connection.',
      setWriteConcern: 'Sets the default write concern for writes on this connection.',
      startSession: 'Starts a session, the entry point for transactions.',
      setCausalConsistency: 'Not supported; pass causalConsistency to startSession() instead.',
      isCausalConsistency: 'Not supported; see session.getOptions().',
      setSecondaryOk: 'Deprecated. Sets the read preference to primaryPreferred.',
      watch: 'Opens a change stream on the whole deployment.',
      convertShardKeyToHashed: 'Returns the hash a hashed index would store for a value.',
      use: 'Switches the current database, like the `use` command.',
      show: 'Runs a `show` command and returns its result.',
      getKeyVault: 'Not available: requires client-side field level encryption.',
      getClientEncryption: 'Not available: requires client-side field level encryption.',
    },
  });

  // ------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------

  const TRANSACTION_RETRY_WINDOW_MS = 120000;

  class Session {
    constructor(mongo, options) {
      const started = native.sessionStart(mongo._clientId, msh.pick(options, ['causalConsistency', 'snapshot', 'defaultTransactionOptions']));
      msh.hide(this, {
        _mongo: mongo,
        _options: options,
        _handle: started.handle,
        _ended: false,
        _inTransaction: false,
        _databases: Object.create(null),
      });
      this.id = started.id;
      mongo._sessions.push(this);
    }

    [asPrintable]() {
      return this.id;
    }

    _assertActive() {
      if (this._ended) throw new msh.errors.MongoExpiredSessionError('Use of expired sessions is not permitted');
    }

    getDatabase(name) {
      msh.required([name], 1, 'Session.getDatabase');
      if (typeof name !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof name} instead (Session.getDatabase)`);
      if (!msh.isValidDatabaseName(name)) throw msh.invalidInput(`Invalid database name: ${name}`);
      if (!(name in this._databases)) this._databases[name] = new msh.Database(this._mongo, name, this);
      return this._databases[name];
    }

    getOptions() {
      return this._options;
    }

    hasEnded() {
      return this._ended;
    }

    endSession() {
      if (this._ended) return;
      if (this._inTransaction) {
        try {
          this.abortTransaction();
        } catch { /* best effort, as in the driver */ }
      }
      native.sessionEnd(this._handle);
      this._ended = true;
      const index = this._mongo._sessions.indexOf(this);
      if (index !== -1) this._mongo._sessions.splice(index, 1);
    }

    getClusterTime() {
      this._assertActive();
      return native.sessionState(this._handle).clusterTime;
    }

    getOperationTime() {
      this._assertActive();
      return native.sessionState(this._handle).operationTime;
    }

    advanceClusterTime(clusterTime) {
      this._assertActive();
      native.sessionAdvance(this._handle, clusterTime, null);
    }

    advanceOperationTime(operationTime) {
      this._assertActive();
      native.sessionAdvance(this._handle, null, operationTime);
    }

    startTransaction(options) {
      this._assertActive();
      if (this._inTransaction) throw new msh.errors.MongoTransactionError('Transaction already in progress');
      native.sessionTransaction(this._handle, 'start', options || null);
      this._inTransaction = true;
    }

    commitTransaction() {
      this._assertActive();
      if (!this._inTransaction) throw new msh.errors.MongoTransactionError('No transaction started');
      try {
        native.sessionTransaction(this._handle, 'commit', null);
      } finally {
        this._inTransaction = false;
      }
    }

    abortTransaction() {
      this._assertActive();
      if (!this._inTransaction) throw new msh.errors.MongoTransactionError('No transaction started');
      try {
        native.sessionTransaction(this._handle, 'abort', null);
      } finally {
        this._inTransaction = false;
      }
    }

    withTransaction(fn, options) {
      msh.required([fn], 1, 'Session.withTransaction');
      const deadline = Date.now() + TRANSACTION_RETRY_WINDOW_MS;
      const transient = (error, label) => !!error && typeof error.hasErrorLabel === 'function' && error.hasErrorLabel(label);
      for (;;) {
        this.startTransaction(options);
        let result;
        try {
          result = fn(this);
        } catch (error) {
          if (this._inTransaction) this.abortTransaction();
          if (transient(error, 'TransientTransactionError') && Date.now() < deadline) continue;
          throw error;
        }
        if (!this._inTransaction) return result;
        for (;;) {
          try {
            this.commitTransaction();
            return result;
          } catch (error) {
            if (transient(error, 'UnknownTransactionCommitResult') && Date.now() < deadline) {
              this._inTransaction = true;
              continue;
            }
            if (transient(error, 'TransientTransactionError') && Date.now() < deadline) break;
            throw error;
          }
        }
      }
    }
  }

  msh.describeClass(Session, {
    type: 'Session',
    help: 'The Session Class. Represents a server session',
    prefix: 'Session',
    docs: `${msh.docs.manual}/js-session`,
    methods: {
      getDatabase: 'Returns a database whose operations run inside this session.',
      advanceOperationTime: 'Moves the operation time of the session forward.',
      advanceClusterTime: 'Moves the cluster time of the session forward.',
      endSession: 'Ends the session, aborting a transaction that is still open.',
      hasEnded: 'Returns true once the session has ended.',
      getClusterTime: 'Returns the latest cluster time seen by the session.',
      getOperationTime: 'Returns the time of the last acknowledged operation in the session.',
      getOptions: 'Returns the options the session was started with.',
      startTransaction: 'Starts a multi-document transaction in the session.',
      commitTransaction: 'Commits the open transaction.',
      abortTransaction: 'Rolls the open transaction back.',
      withTransaction: 'Runs a function in a transaction, retrying on transient errors.',
    },
  });

  Object.assign(msh, { Mongo, Session });
})(globalThis);
