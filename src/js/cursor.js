// Cursors: the low-level batch cursor over the native bridge, and the shell
// classes built on it (Cursor, AggregationCursor, RunCommandCursor,
// ChangeStreamCursor).
(function (g) {
  'use strict';

  const msh = g.__msh;
  const native = msh.native;
  const { asPrintable, inspectCustom } = msh.symbols;
  const { Long } = msh.bson;
  const {
    MongoInvalidArgumentError, MongoshDeprecatedError, MongoshUnimplementedError, MongoshRuntimeError,
    MongoshInvalidInputError, MongoCursorInUseError, MongoCursorExhaustedError,
  } = msh.errors;

  // ------------------------------------------------------------------
  // Batch cursor
  // ------------------------------------------------------------------

  const isZeroId = (id) => id === undefined || id === null || id === 0 || (Long.isLong(id) && id.isZero());

  /**
   * One server cursor. The driver owns the getMore loop (session, server
   * pinning, cleanup); this class buffers one batch at a time, which is what
   * `objsLeftInBatch()` and the "Type it for more" paging are defined on.
   */
  class BatchCursor {
    constructor(mongo, dbName, buildCommand, options) {
      this.mongo = mongo;
      this.dbName = dbName;
      this.buildCommand = buildCommand;
      this.options = options || {};
      // The current batch and the read position in it. Reading advances the
      // position instead of shifting the array, which would cost O(batch) per
      // document.
      this.buffer = [];
      this.position = 0;
      this.handle = null;
      this.id = null;
      this.started = false;
      // "closed" means the server side is finished: either it reported
      // cursor id 0 or close() was called. Buffered documents may remain.
      this.closed = false;
      // Set by an explicit close(); the cursor then refuses to iterate.
      this.killed = false;
      this.resumeToken = undefined;
    }

    accept(reply) {
      const cursor = reply && reply.cursor;
      if (!cursor) {
        this.finish();
        return;
      }
      const batch = msh.fromServer(cursor.firstBatch || cursor.nextBatch || []);
      this.buffer = this.buffered() ? this.buffer.slice(this.position).concat(batch) : batch;
      this.position = 0;
      this.id = cursor.id;
      if (cursor.postBatchResumeToken !== undefined) this.resumeToken = cursor.postBatchResumeToken;
      if (isZeroId(cursor.id)) this.finish();
    }

    /** Documents of the current batch that have not been read yet. */
    buffered() {
      return this.buffer.length - this.position;
    }

    take() {
      const doc = this.buffer[this.position++];
      if (this.position === this.buffer.length) {
        this.buffer = [];
        this.position = 0;
      }
      return doc;
    }

    finish() {
      this.closed = true;
      if (this.handle !== null) {
        native.cursorClose(this.handle);
        this.handle = null;
      }
    }

    start() {
      if (this.started) return;
      this.mongo._assertOpen();
      this.started = true;
      const opened = native.cursorOpen(this.mongo._clientId, this.dbName, this.buildCommand(), this.options);
      this.handle = opened.handle;
      this.accept(opened.reply);
    }

    /** Fetch one more batch. Returns false when the cursor is finished. */
    fetch() {
      if (this.closed || this.handle === null) return false;
      const reply = native.cursorMore(this.handle);
      if (reply === null) {
        this.handle = null;
        this.closed = true;
        return false;
      }
      this.accept(reply);
      return true;
    }

    /** Next document, or null when exhausted. Blocks across batches. */
    next() {
      this.start();
      for (;;) {
        if (this.buffered()) return this.take();
        if (!this.fetch()) return null;
      }
    }

    /** Next document, issuing at most one getMore (for tailable cursors). */
    tryNext() {
      this.start();
      if (this.buffered()) return this.take();
      if (!this.fetch()) return null;
      return this.buffered() ? this.take() : null;
    }

    hasNext() {
      this.start();
      for (;;) {
        if (this.buffered()) return true;
        if (!this.fetch()) return false;
      }
    }

    close() {
      this.started = true;
      this.killed = true;
      this.finish();
    }
  }
  msh.BatchCursor = BatchCursor;

  const BLOCK_WARNING = (what) => `Warning: ${what} Use tryNext if you want to check if there are any documents without waiting, or cursor.disableBlockWarnings() if you want to disable this warning.`;

  // ------------------------------------------------------------------
  // Option normalisation
  // ------------------------------------------------------------------

  function sortDirection(direction) {
    const value = `${direction}`.toLowerCase();
    if (direction !== null && typeof direction === 'object' && '$meta' in direction) return direction;
    switch (value) {
      case 'ascending': case 'asc': case '1': return 1;
      case 'descending': case 'desc': case '-1': return -1;
      default: throw new MongoInvalidArgumentError(`Invalid sort direction: ${JSON.stringify(direction)}`);
    }
  }

  /** Accepts the sort forms the Node driver does and returns a document. */
  function formatSort(sort, direction) {
    if (sort === undefined || sort === null) return undefined;
    if (typeof sort === 'string') return { [sort]: sortDirection(direction === undefined ? 1 : direction) };
    if (typeof sort !== 'object') {
      throw new MongoInvalidArgumentError(`Invalid sort format: ${JSON.stringify(sort)} Sort must be a valid object`);
    }
    const out = {};
    if (Array.isArray(sort)) {
      if (!sort.length) return undefined;
      const pairs = Array.isArray(sort[0]) ? sort : sort.length === 2 && typeof sort[1] !== 'object' && /^(1|-1|asc|desc|ascending|descending)$/i.test(`${sort[1]}`) ? [sort] : sort.map((key) => [key, 1]);
      for (const [key, dir] of pairs) out[`${key}`] = sortDirection(dir);
      return out;
    }
    const entries = sort instanceof Map ? Array.from(sort.entries()) : Object.entries(sort);
    if (!entries.length) return undefined;
    for (const [key, dir] of entries) out[`${key}`] = sortDirection(dir);
    return out;
  }
  msh.formatSort = formatSort;

  function assertInteger(value, operation) {
    if (typeof value !== 'number') throw new MongoInvalidArgumentError(`Operation "${operation}" requires an integer`);
  }

  // ------------------------------------------------------------------
  // Shell cursors
  // ------------------------------------------------------------------

  class CursorIterationResult {
    constructor() {
      this.cursorHasMore = true;
      this.documents = msh.serverContainer([]);
    }
  }
  msh.describeClass(CursorIterationResult, { type: 'CursorIterationResult', help: 'CursorIterationResult', methods: {} });
  msh.CursorIterationResult = CursorIterationResult;

  class AbstractCursor {
    constructor(mongo) {
      this._mongo = mongo;
      this._batch = null;
      this._transform = null;
      this._blockWarningsDisabled = false;
      this._currentIterationResult = null;
    }

    _cursor() {
      if (this._batch === null) this._batch = this._open();
      return this._batch;
    }

    _started() {
      return this._batch !== null && this._batch.started;
    }

    _assertNotStarted() {
      if (this._started()) throw new MongoCursorInUseError('Cursor is already initialized');
    }

    _killed() {
      return this._batch !== null && this._batch.killed;
    }

    _assertNotKilled() {
      if (this._killed()) throw new MongoCursorExhaustedError('Cursor is exhausted');
    }

    /** Tailable cursors wait for data; say so the first time. */
    _warnIfBlocking() {
      if (this._tailable() && !this._blockWarningsDisabled) {
        msh.warnOnce(BLOCK_WARNING('If this is a tailable cursor with awaitData, and there are no documents in the batch, this method will will block.'));
      }
    }

    _apply(doc) {
      return this._transform ? this._transform(doc) : doc;
    }

    /** One screenful of results; `it` asks for the next one. */
    _it() {
      const results = (this._currentIterationResult = new CursorIterationResult());
      const size = msh.displayBatchSize();
      if (!this._killed()) {
        for (let i = 0; i < size; i++) {
          const doc = this.tryNext();
          if (doc === null) {
            results.cursorHasMore = false;
            break;
          }
          results.documents.push(doc);
        }
      }
      results.cursorHasMore = !this.isExhausted();
      return results;
    }

    [asPrintable]() {
      return this._it();
    }

    [inspectCustom]() {
      return `[${this[msh.symbols.shellApiType]}]`;
    }

    batchSize(size) {
      assertInteger(size, 'batchSize');
      this._setBatchSize(size);
      return this;
    }

    close() {
      this._cursor().close();
    }

    forEach(f) {
      if (typeof f !== 'function') throw msh.invalidInput('Missing required argument at position 0 (Cursor.forEach)');
      for (;;) {
        const doc = this.tryNext();
        if (doc === null) {
          if (this.isExhausted() || !this._tailable()) break;
          continue;
        }
        if (f(doc) === false) break;
      }
    }

    hasNext() {
      if (this._killed()) return false;
      this._warnIfBlocking();
      return this._cursor().hasNext();
    }

    /** True once the server cursor is finished and its last batch is read. */
    isClosed() {
      return this._batch !== null && this._batch.closed && this._batch.buffered() === 0;
    }

    isExhausted() {
      return this.isClosed() && this.objsLeftInBatch() === 0;
    }

    itcount() {
      let count = 0;
      while (this.tryNext() !== null) count++;
      return count;
    }

    map(f) {
      if (typeof f !== 'function') throw msh.invalidInput('Missing required argument at position 0 (Cursor.map)');
      const previous = this._transform;
      this._transform = previous ? (doc) => f(previous(doc)) : f;
      return this;
    }

    maxTimeMS(value) {
      if (typeof value !== 'number') throw new MongoInvalidArgumentError('Argument for maxTimeMS must be a number');
      this._assertNotStarted();
      this._setMaxTimeMS(value);
      return this;
    }

    next() {
      this._assertNotKilled();
      this._warnIfBlocking();
      const doc = this._cursor().next();
      return doc === null ? null : this._apply(doc);
    }

    tryNext() {
      this._assertNotKilled();
      const doc = this._cursor().tryNext();
      return doc === null ? null : this._apply(doc);
    }

    toArray() {
      const out = [];
      if (this._killed()) return msh.serverContainer(out);
      for (;;) {
        const doc = this._cursor().next();
        if (doc === null) break;
        out.push(this._apply(doc));
      }
      return msh.serverContainer(out);
    }

    objsLeftInBatch() {
      return this._batch === null ? 0 : this._batch.buffered();
    }

    pretty() {
      return this;
    }

    disableBlockWarnings() {
      this._blockWarningsDisabled = true;
      return this;
    }

    toJSON() {
      throw msh.invalidInput('Cannot serialize a cursor to JSON. Did you mean to call .toArray() first?');
    }

    _tailable() {
      return false;
    }

    *[Symbol.iterator]() {
      for (;;) {
        const doc = this.tryNext();
        if (doc === null) {
          if (this.isExhausted() || !this._tailable()) return;
          continue;
        }
        yield doc;
      }
    }

    async *[Symbol.asyncIterator]() {
      yield* this[Symbol.iterator]();
    }
  }

  // ---- find cursor ---------------------------------------------------

  const FIND_OPTION_KEYS = [
    'sort', 'projection', 'hint', 'skip', 'limit', 'batchSize', 'singleBatch', 'comment', 'maxTimeMS',
    'readConcern', 'max', 'min', 'returnKey', 'showRecordId', 'tailable', 'awaitData', 'noCursorTimeout',
    'allowPartialResults', 'collation', 'allowDiskUse', 'let', 'oplogReplay',
  ];

  class Cursor extends AbstractCursor {
    constructor(mongo, collection, filter, options) {
      super(mongo);
      this._collection = collection;
      this._filter = filter === undefined || filter === null ? {} : filter;
      this._options = {};
      this._readPref = undefined;
      this._maxAwaitTimeMS = undefined;
      const opts = options || {};
      for (const key of FIND_OPTION_KEYS) {
        if (opts[key] !== undefined) this._options[key] = opts[key];
      }
      if (this._options.sort !== undefined) this._options.sort = formatSort(this._options.sort);
      if (opts.readPreference !== undefined) this._readPref = msh.normalizeReadPreference(opts.readPreference);
      if (opts.maxAwaitTimeMS !== undefined) this._maxAwaitTimeMS = opts.maxAwaitTimeMS;
    }

    _command() {
      const o = this._options;
      const cmd = { find: this._collection._name, filter: this._filter };
      for (const key of FIND_OPTION_KEYS) {
        if (o[key] === undefined) continue;
        if (key === 'limit') {
          // A negative limit asks for a single batch of that many documents.
          if (o.limit < 0) {
            cmd.limit = -o.limit;
            cmd.singleBatch = true;
          } else if (o.limit !== 0) {
            cmd.limit = o.limit;
          }
        } else if (key === 'batchSize') {
          if (o.batchSize < 0) {
            if (o.limit === undefined || o.limit === 0 || Math.abs(o.batchSize) < Math.abs(o.limit)) cmd.limit = -o.batchSize;
            cmd.singleBatch = true;
          } else {
            cmd.batchSize = o.batchSize;
          }
        } else if (key === 'oplogReplay') {
          // Accepted for compatibility; the server ignores it since 4.4.
        } else {
          cmd[key] = o[key];
        }
      }
      return cmd;
    }

    _open() {
      const readPreference = this._readPref || this._mongo._readPreferenceForReads();
      return new BatchCursor(this._mongo, this._collection._database._name, () => this._command(), msh.compact({
        session: this._collection._database._sessionHandle(),
        readPreference,
        batchSize: this._options.batchSize > 0 ? this._options.batchSize : undefined,
        maxTimeMS: this._options.tailable && this._options.awaitData ? this._maxAwaitTimeMS : undefined,
        comment: this._options.comment,
        tailable: this._options.tailable || undefined,
        awaitData: this._options.awaitData || undefined,
      }));
    }

    _set(key, value) {
      this._assertNotStarted();
      this._options[key] = value;
      return this;
    }

    _setBatchSize(size) {
      this._assertNotStarted();
      this._options.batchSize = size;
    }

    _setMaxTimeMS(value) {
      this._options.maxTimeMS = value;
    }

    _tailable() {
      return !!this._options.tailable;
    }

    addOption(optionFlagNumber) {
      if (optionFlagNumber === 4) {
        throw new MongoshUnimplementedError('the slaveOk option is not supported.', 'COMMON-90002');
      }
      const flags = { 2: 'tailable', 8: 'oplogReplay', 16: 'noCursorTimeout', 32: 'awaitData', 64: 'exhaust', 128: 'partial' };
      const flag = flags[optionFlagNumber];
      if (!flag) throw msh.invalidInput(`Unknown option flag number: ${optionFlagNumber}.`);
      if (flag === 'partial') return this._set('allowPartialResults', true);
      if (flag === 'exhaust') return this;
      return this._set(flag, true);
    }

    allowDiskUse(allow) {
      if (this._options.sort === undefined) {
        throw new MongoInvalidArgumentError('Option "allowDiskUse" requires a sort specification');
      }
      return this._set('allowDiskUse', allow === undefined ? true : !!allow);
    }

    allowPartialResults() {
      return this._set('allowPartialResults', true);
    }

    collation(spec) {
      return this._set('collation', spec);
    }

    comment(cmt) {
      return this._set('comment', cmt);
    }

    /** Like the driver's cursor.count(): skip and limit are applied. */
    count() {
      return this.size();
    }

    size() {
      const o = this._options;
      const reply = this._collection._run(msh.compact({
        count: this._collection._name,
        query: this._filter,
        limit: typeof o.limit === 'number' && o.limit !== 0 ? Math.abs(o.limit) : undefined,
        skip: typeof o.skip === 'number' && o.skip !== 0 ? o.skip : undefined,
        hint: o.hint,
        maxTimeMS: o.maxTimeMS,
        collation: o.collation,
      }), { read: true });
      return reply.n;
    }

    explain(verbosity) {
      const command = this._command();
      // Explaining is a one-off: it must not consume or start this cursor.
      return this._collection._run({ explain: command, verbosity: msh.explainVerbosity(verbosity) }, { read: true });
    }

    hint(index) {
      return this._set('hint', index);
    }

    limit(value) {
      assertInteger(value, 'limit');
      return this._set('limit', value);
    }

    max(indexBounds) {
      return this._set('max', indexBounds);
    }

    maxAwaitTimeMS(value) {
      if (typeof value !== 'number') throw new MongoInvalidArgumentError('Argument for maxAwaitTimeMS must be a number');
      this._assertNotStarted();
      this._maxAwaitTimeMS = value;
      return this;
    }

    maxScan() {
      throw new MongoshDeprecatedError('`maxScan()` was removed because it was deprecated in MongoDB 4.0', 'COMMON-10003');
    }

    min(indexBounds) {
      return this._set('min', indexBounds);
    }

    noCursorTimeout() {
      return this._set('noCursorTimeout', true);
    }

    oplogReplay() {
      return this._set('oplogReplay', true);
    }

    projection(spec) {
      return this._set('projection', spec);
    }

    readPref(mode, tagSet, hedgeOptions) {
      this._assertNotStarted();
      this._readPref = msh.normalizeReadPreference(mode, tagSet, hedgeOptions);
      return this;
    }

    readConcern(level) {
      return this._set('readConcern', { level });
    }

    returnKey(enabled) {
      return this._set('returnKey', enabled);
    }

    showRecordId() {
      return this._set('showRecordId', true);
    }

    skip(value) {
      assertInteger(value, 'skip');
      return this._set('skip', value);
    }

    sort(spec) {
      return this._set('sort', formatSort(spec));
    }

    tailable(opts) {
      this._set('tailable', true);
      if (opts && opts.awaitData) this._options.awaitData = true;
      return this;
    }
  }
  Cursor.prototype.showDiskLoc = Cursor.prototype.showRecordId;

  msh.describeClass(Cursor, {
    type: 'Cursor',
    help: 'Collection Cursor',
    prefix: 'Cursor',
    docs: `${msh.docs.manual}/js-cursor`,
    methods: {
      addOption: 'Sets a legacy query flag by number, such as tailable (2) or noCursorTimeout (16).',
      allowDiskUse: 'Lets the server write temporary files for a blocking sort. Defaults to true when called without an argument.',
      allowPartialResults: 'Returns partial results from a sharded cluster when some shards are unavailable.',
      batchSize: 'Sets how many documents the server returns per batch, and how many the shell prints per iteration.',
      close: 'Closes the cursor and frees its server resources.',
      collation: 'Sets the collation used to compare strings in the query.',
      comment: 'Attaches a comment to the query; it shows up in logs and the profiler.',
      count: 'Counts the documents matching the query, honouring skip and limit.',
      explain: 'Returns the query plan for the cursor. Accepts a verbosity mode.',
      forEach: 'Calls a function for each document. Returning false stops the iteration.',
      hasNext: 'Returns true when another document is available. May block on a tailable cursor.',
      hint: 'Forces the query to use the given index (name or key pattern).',
      isClosed: 'Returns true once the server-side cursor is closed.',
      isExhausted: 'Returns true when the cursor is closed and no buffered documents remain.',
      itcount: 'Iterates the cursor and returns how many documents it yielded.',
      limit: 'Sets the maximum number of documents the cursor returns.',
      map: 'Applies a function to each document as it is returned.',
      max: 'Sets the exclusive upper index bound for the query. Requires hint().',
      maxAwaitTimeMS: 'Sets how long a tailable awaitData cursor waits for new documents on each getMore.',
      maxTimeMS: 'Sets a time limit in milliseconds for the query on the server.',
      min: 'Sets the inclusive lower index bound for the query. Requires hint().',
      next: 'Returns the next document, or null when the cursor is exhausted.',
      noCursorTimeout: 'Keeps the server from closing the cursor after ten idle minutes.',
      objsLeftInBatch: 'Returns how many documents remain in the current batch.',
      oplogReplay: 'Legacy flag for oplog queries. Ignored by servers since MongoDB 4.4.',
      pretty: 'Kept for compatibility. Results are always pretty-printed.',
      projection: 'Sets which fields the returned documents include.',
      readConcern: 'Sets the read concern level for the query.',
      readPref: 'Sets the read preference used to route the query.',
      returnKey: 'When passed true, returns only the index keys of the matching documents.',
      showRecordId: 'Adds a $recordId field with the storage engine record id to each document.',
      size: 'Counts the documents matching the query after applying skip and limit.',
      skip: 'Sets how many documents to skip before returning results.',
      sort: 'Sets the order in which matching documents are returned.',
      tailable: 'Makes the cursor tailable so it stays open on a capped collection.',
      toArray: 'Returns all remaining documents as an array.',
      tryNext: 'Returns the next document if one is ready, without waiting on a tailable cursor.',
    },
  });

  // ---- aggregation cursor ----------------------------------------------

  class AggregationCursor extends AbstractCursor {
    constructor(mongo, database, collectionName, pipeline, options) {
      super(mongo);
      this._database = database;
      this._collectionName = collectionName;
      this._pipeline = pipeline.slice();
      this._options = Object.assign({}, options);
    }

    _hasWriteStage() {
      const last = this._pipeline[this._pipeline.length - 1];
      return !!last && typeof last === 'object' && ('$out' in last || '$merge' in last);
    }

    _command() {
      const o = this._options;
      const cursor = {};
      if (typeof o.batchSize === 'number' && !this._hasWriteStage()) cursor.batchSize = o.batchSize;
      const cmd = { aggregate: this._collectionName === null ? 1 : this._collectionName, pipeline: this._pipeline, cursor };
      for (const key of ['allowDiskUse', 'maxTimeMS', 'bypassDocumentValidation', 'readConcern', 'collation', 'hint', 'comment', 'let', 'writeConcern']) {
        if (o[key] !== undefined) cmd[key] = o[key];
      }
      return cmd;
    }

    _open() {
      const readPreference = this._hasWriteStage()
        ? undefined
        : (this._options.readPreference ? msh.normalizeReadPreference(this._options.readPreference) : this._mongo._readPreferenceForReads());
      return new BatchCursor(this._mongo, this._database._name, () => this._command(), msh.compact({
        session: this._database._sessionHandle(),
        readPreference,
        batchSize: typeof this._options.batchSize === 'number' && this._options.batchSize > 0 ? this._options.batchSize : undefined,
        comment: this._options.comment,
      }));
    }

    _setBatchSize(size) {
      this._assertNotStarted();
      this._options.batchSize = size;
    }

    _setMaxTimeMS(value) {
      this._options.maxTimeMS = value;
    }

    _addStage(stage) {
      this._assertNotStarted();
      this._pipeline.push(stage);
      return this;
    }

    explain(verbosity) {
      const cmd = this._command();
      delete cmd.writeConcern;
      return this._database._run({ explain: cmd, verbosity: msh.explainVerbosity(verbosity) }, { read: true });
    }

    projection(spec) {
      return this._addStage({ $project: spec });
    }

    skip(value) {
      assertInteger(value, 'skip');
      return this._addStage({ $skip: value });
    }

    sort(spec, direction) {
      return this._addStage({ $sort: formatSort(spec, direction) });
    }
  }

  msh.describeClass(AggregationCursor, {
    type: 'AggregationCursor',
    help: 'Aggregation Cursor',
    prefix: 'AggregationCursor',
    docs: `${msh.docs.manual}/js-cursor`,
    methods: {
      batchSize: 'Sets how many documents the server returns per batch, and how many the shell prints per iteration.',
      close: 'Closes the cursor and frees its server resources.',
      explain: 'Returns the execution plan of the aggregation pipeline.',
      forEach: 'Calls a function for each document. Returning false stops the iteration.',
      hasNext: 'Returns true when another document is available.',
      isClosed: 'Returns true once the server-side cursor is closed.',
      isExhausted: 'Returns true when the cursor is closed and no buffered documents remain.',
      itcount: 'Iterates the cursor and returns how many documents it yielded.',
      map: 'Applies a function to each document as it is returned.',
      maxTimeMS: 'Sets a time limit in milliseconds for the pipeline on the server.',
      next: 'Returns the next document, or null when the cursor is exhausted.',
      objsLeftInBatch: 'Returns how many documents remain in the current batch.',
      pretty: 'Kept for compatibility. Results are always pretty-printed.',
      projection: 'Appends a $project stage to the pipeline.',
      skip: 'Appends a $skip stage to the pipeline.',
      sort: 'Appends a $sort stage to the pipeline.',
      toArray: 'Returns all remaining documents as an array.',
      tryNext: 'Returns the next document if one is ready.',
    },
  });

  // ---- run-command cursor ------------------------------------------------

  class RunCommandCursor extends AbstractCursor {
    constructor(mongo, database, command, options) {
      super(mongo);
      this._database = database;
      this._commandDoc = command;
      this._options = options || {};
    }

    _open() {
      return new BatchCursor(this._mongo, this._database._name, () => this._commandDoc, msh.compact({
        session: this._database._sessionHandle(),
        batchSize: this._options.batchSize,
        maxTimeMS: this._options.maxTimeMS,
        comment: this._options.comment,
      }));
    }

    _setBatchSize(size) {
      this._assertNotStarted();
      this._options.batchSize = size;
    }

    _setMaxTimeMS(value) {
      this._options.maxTimeMS = value;
    }
  }

  msh.describeClass(RunCommandCursor, {
    type: 'RunCommandCursor',
    help: 'Command Cursor',
    prefix: 'RunCommandCursor',
    docs: `${msh.docs.manual}/js-cursor`,
    methods: {
      batchSize: 'Sets how many documents the server returns per batch.',
      close: 'Closes the cursor and frees its server resources.',
      forEach: 'Calls a function for each document.',
      hasNext: 'Returns true when another document is available.',
      isClosed: 'Returns true once the server-side cursor is closed.',
      isExhausted: 'Returns true when the cursor is closed and no buffered documents remain.',
      itcount: 'Iterates the cursor and returns how many documents it yielded.',
      maxTimeMS: 'Sets a time limit in milliseconds for each getMore.',
      next: 'Returns the next document, or null when the cursor is exhausted.',
      objsLeftInBatch: 'Returns how many documents remain in the current batch.',
      toArray: 'Returns all remaining documents as an array.',
      tryNext: 'Returns the next document if one is ready.',
    },
  });

  // ---- change streams ----------------------------------------------------

  class ChangeStreamCursor extends AbstractCursor {
    constructor(mongo, database, collectionName, pipeline, options, description) {
      super(mongo);
      this._database = database;
      this._collectionName = collectionName;
      this._pipeline = pipeline;
      this._options = options || {};
      this._description = description;
    }

    _open() {
      const o = this._options;
      const stage = msh.pick(o, [
        'fullDocument', 'fullDocumentBeforeChange', 'resumeAfter', 'startAfter', 'startAtOperationTime',
        'allChangesForCluster', 'showExpandedEvents',
      ]);
      const cmd = msh.compact({
        aggregate: this._collectionName === null ? 1 : this._collectionName,
        pipeline: [{ $changeStream: stage }, ...this._pipeline],
        cursor: typeof o.batchSize === 'number' ? { batchSize: o.batchSize } : {},
        collation: o.collation,
        comment: o.comment,
      });
      return new BatchCursor(this._mongo, this._database._name, () => cmd, msh.compact({
        session: this._database._sessionHandle(),
        readPreference: this._mongo._readPreferenceForReads(),
        batchSize: o.batchSize,
        maxTimeMS: o.maxAwaitTimeMS,
        tailable: true,
        awaitData: true,
      }));
    }

    _tailable() {
      return true;
    }

    _it() {
      const results = (this._currentIterationResult = new CursorIterationResult());
      for (let i = 0; i < msh.displayBatchSize(); i++) {
        const doc = this.tryNext();
        if (doc === null) break;
        results.documents.push(doc);
      }
      results.cursorHasMore = true;
      return results;
    }

    _assertOpen(method) {
      if (this._killed()) throw new MongoshRuntimeError(`Cannot call ${method} on closed cursor`);
    }

    [asPrintable]() {
      return `ChangeStreamCursor on ${this._description}`;
    }

    _setBatchSize(size) {
      this._options.batchSize = size;
    }

    _setMaxTimeMS() {
      throw msh.invalidInput('Cannot call maxTimeMS on a change stream cursor');
    }

    hasNext() {
      this._assertOpen('hasNext');
      if (!this._blockWarningsDisabled) msh.warnOnce(BLOCK_WARNING('If there are no documents in the batch, hasNext will block.'));
      for (;;) {
        const cursor = this._cursor();
        cursor.start();
        if (cursor.buffered()) return true;
        if (!cursor.fetch()) return false;
      }
    }

    next() {
      this._assertOpen('next');
      if (!this._blockWarningsDisabled) msh.warnOnce(BLOCK_WARNING('If there are no documents in the batch, next will block.'));
      for (;;) {
        const doc = super.tryNext();
        if (doc !== null) return doc;
        if (this._batch.closed) return null;
      }
    }

    tryNext() {
      this._assertOpen('tryNext');
      return super.tryNext();
    }

    isClosed() {
      return this._batch !== null && this._batch.closed;
    }

    isExhausted() {
      throw new MongoshInvalidInputError('isExhausted is not implemented for ChangeStreams because after closing a cursor, the remaining documents in the batch are no longer accessible. If you want to see if the cursor is closed use isClosed. If you want to see if there are documents left in the batch, use tryNext.');
    }

    toArray() {
      throw new MongoshInvalidInputError('Cannot call toArray on a change stream cursor; iterate it with tryNext() instead');
    }

    getResumeToken() {
      return this._batch === null ? undefined : this._batch.resumeToken;
    }
  }

  msh.describeClass(ChangeStreamCursor, {
    type: 'ChangeStreamCursor',
    help: 'Change Stream Cursor',
    prefix: 'ChangeStreamCursor',
    docs: `${msh.docs.manual}/js-cursor`,
    methods: {
      close: 'Closes the change stream.',
      getResumeToken: 'Returns the token to resume the stream after the last event received.',
      hasNext: 'Waits until another event is available. Blocks while the stream is idle.',
      isClosed: 'Returns true once the change stream is closed.',
      itcount: 'Returns the number of events currently available.',
      next: 'Returns the next event, waiting for one if necessary.',
      tryNext: 'Returns the next event if one is available, otherwise null.',
    },
  });

  Object.assign(msh, { AbstractCursor, Cursor, AggregationCursor, RunCommandCursor, ChangeStreamCursor });
})(globalThis);
