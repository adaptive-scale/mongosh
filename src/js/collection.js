// The Collection class and its helpers (write results, bulk operations,
// Explainable, PlanCache). Every operation is expressed as the server command
// the Node driver would send, so options pass straight through.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const native = msh.native;
  const { asPrintable } = msh.symbols;
  const { ObjectId, Code, Long } = msh.bson;
  const {
    MongoServerError, MongoBulkWriteError, MongoWriteConcernError, MongoInvalidArgumentError,
    MongoBatchReExecutionError, MongoshInvalidInputError, MongoshRuntimeError,
  } = msh.errors;

  const MAX_WRITE_BATCH_SIZE = 100000;
  // Stay under the 16 MiB command document limit with room for the envelope.
  const MAX_BATCH_BYTES = 16 * 1024 * 1024 - 16 * 1024;

  const toNumber = (value) => (Long.isLong(value) ? value.toNumber() : Number(value || 0));

  // ------------------------------------------------------------------
  // Results
  // ------------------------------------------------------------------

  class InsertOneResult {
    constructor(acknowledged, insertedId) {
      this.acknowledged = acknowledged;
      this.insertedId = insertedId;
    }
  }
  class InsertManyResult {
    constructor(acknowledged, insertedIds) {
      this.acknowledged = acknowledged;
      this.insertedIds = insertedIds;
    }
  }
  class UpdateResult {
    constructor(acknowledged, matchedCount, modifiedCount, upsertedCount, insertedId) {
      this.acknowledged = acknowledged;
      this.insertedId = insertedId;
      this.matchedCount = matchedCount;
      this.modifiedCount = modifiedCount;
      this.upsertedCount = upsertedCount;
    }
  }
  class DeleteResult {
    constructor(acknowledged, deletedCount) {
      this.acknowledged = acknowledged;
      this.deletedCount = deletedCount;
    }
  }
  class BulkWriteResult {
    constructor(acknowledged, r) {
      this.acknowledged = acknowledged;
      this.insertedCount = r.insertedCount;
      this.insertedIds = r.insertedIds;
      this.matchedCount = r.matchedCount;
      this.modifiedCount = r.modifiedCount;
      this.deletedCount = r.deletedCount;
      this.upsertedCount = r.upsertedCount;
      this.upsertedIds = r.upsertedIds;
    }
  }
  // What the driver attaches to a MongoBulkWriteError: the same counts under
  // the same class name, in the driver's own field order.
  const DriverBulkWriteResult = {
    BulkWriteResult: class {
      constructor(r) {
        this.insertedCount = r.insertedCount;
        this.matchedCount = r.matchedCount;
        this.modifiedCount = r.modifiedCount;
        this.deletedCount = r.deletedCount;
        this.upsertedCount = r.upsertedCount;
        this.upsertedIds = r.upsertedIds;
        this.insertedIds = r.insertedIds;
      }
    },
  }.BulkWriteResult;

  for (const cls of [InsertOneResult, InsertManyResult, UpdateResult, DeleteResult, BulkWriteResult]) {
    msh.describeClass(cls, { type: cls.name, help: cls.name, methods: {}, plain: true });
  }

  class WriteError {
    constructor(err) {
      this.err = err;
    }
    get code() { return this.err.code; }
    get index() { return this.err.index; }
    get errmsg() { return this.err.errmsg; }
    get errInfo() { return this.err.errInfo; }
    getOperation() { return this.err.op; }
    toJSON() { return { code: this.err.code, index: this.err.index, errmsg: this.err.errmsg, op: this.err.op }; }
    toString() { return `WriteError(${JSON.stringify(this.toJSON())})`; }
  }

  // ------------------------------------------------------------------
  // Validation helpers
  // ------------------------------------------------------------------

  function hasAtomicOperators(doc) {
    if (Array.isArray(doc)) return true;
    if (doc === null || typeof doc !== 'object') return false;
    const keys = Object.keys(doc);
    return keys.length > 0 && keys[0][0] === '$';
  }

  function assertUpdate(update) {
    if (!hasAtomicOperators(update)) throw new MongoInvalidArgumentError('Update document requires atomic operators');
  }

  function assertReplacement(replacement) {
    if (hasAtomicOperators(replacement)) throw new MongoInvalidArgumentError('Replacement document must not contain atomic operators');
  }

  const copyDoc = (doc) => (msh.isPlainObject(doc) ? Object.assign({}, doc) : doc);

  /** Assigns a generated `_id` when the document has none. */
  function ensureId(doc) {
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc) && doc._id === undefined) {
      doc._id = new ObjectId();
    }
    return doc;
  }

  msh.explainVerbosity = function (verbosity) {
    if (verbosity === true) verbosity = 'allPlansExecution';
    else if (verbosity === false || verbosity === undefined) verbosity = 'queryPlanner';
    if (typeof verbosity !== 'string') throw msh.invalidInput('verbosity must be a string');
    return verbosity;
  };

  /** Normalise the several spellings of "return the new document". */
  function findAndModifyOptions(options) {
    options = Object.assign({}, options);
    if ('returnDocument' in options) {
      if (options.returnDocument !== 'before' && options.returnDocument !== 'after') {
        throw msh.invalidInput("returnDocument needs to be either 'before' or 'after'");
      }
      delete options.returnNewDocument;
      delete options.returnOriginal;
      return options;
    }
    if ('returnOriginal' in options) {
      options.returnDocument = options.returnOriginal ? 'before' : 'after';
    } else if ('returnNewDocument' in options) {
      options.returnDocument = options.returnNewDocument ? 'after' : 'before';
    } else if ('new' in options) {
      options.returnDocument = options.new ? 'after' : 'before';
    } else {
      options.returnDocument = 'before';
    }
    delete options.returnOriginal;
    delete options.returnNewDocument;
    delete options.new;
    return options;
  }

  function generateIndexName(key) {
    const entries = key instanceof Map ? Array.from(key.entries()) : Object.entries(key);
    return entries.map(([field, direction]) => `${field}_${direction}`).join('_');
  }

  // ------------------------------------------------------------------
  // Bulk execution
  // ------------------------------------------------------------------

  const COMMAND_FOR = { insert: 'insert', update: 'update', delete: 'delete' };
  const PAYLOAD_FOR = { insert: 'documents', update: 'updates', delete: 'deletes' };

  /** Split operations into command-sized batches of a single type each. */
  function buildBatches(ops, ordered) {
    const batches = [];
    const open = {};
    const measure = ops.length > 1;
    for (const op of ops) {
      const size = measure ? native.bsonSize(op.type === 'insert' ? op.payload : { d: op.payload }) : 0;
      let batch = ordered ? batches[batches.length - 1] : open[op.type];
      if (!batch || batch.type !== op.type || batch.ops.length >= MAX_WRITE_BATCH_SIZE || batch.bytes + size > MAX_BATCH_BYTES) {
        batch = { type: op.type, ops: [], bytes: 0 };
        batches.push(batch);
        open[op.type] = batch;
      }
      batch.ops.push(op);
      batch.bytes += size;
    }
    return batches;
  }

  /**
   * Run a list of write operations and merge the replies the way the Node
   * driver's bulk API does. Each op is `{ type, payload, index }`.
   */
  function executeBulk(collection, ops, options) {
    options = options || {};
    const ordered = options.ordered !== false;
    const state = {
      insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0,
      insertedIds: {}, upsertedIds: {},
    };
    const inserted = [];
    const writeErrors = [];
    let writeConcernError = null;
    const shared = msh.pick(options, ['bypassDocumentValidation', 'comment', 'let', 'maxTimeMS']);
    const writeConcern = collection._writeConcern(options);

    // The driver numbers inserted ids by operation in an ordered run and by
    // their position among the inserts in an unordered one.
    for (const op of ops) {
      if (op.type === 'insert') inserted.push({ index: op.index, key: ordered ? op.index : inserted.length, _id: op.payload._id });
    }

    let stop = false;
    for (const batch of buildBatches(ops, ordered)) {
      if (stop) break;
      const cmd = Object.assign(
        { [COMMAND_FOR[batch.type]]: collection._name, [PAYLOAD_FOR[batch.type]]: batch.ops.map((op) => op.payload), ordered },
        shared,
      );
      if (writeConcern !== undefined) cmd.writeConcern = writeConcern;
      const reply = collection._run(cmd);
      const n = toNumber(reply.n);
      if (batch.type === 'insert') {
        state.insertedCount += n;
      } else if (batch.type === 'update') {
        const upserted = Array.isArray(reply.upserted) ? reply.upserted : [];
        for (const entry of upserted) state.upsertedIds[batch.ops[entry.index].index] = entry._id;
        state.upsertedCount += upserted.length;
        state.matchedCount += n - upserted.length;
        state.modifiedCount += toNumber(reply.nModified);
      } else {
        state.deletedCount += n;
      }
      if (Array.isArray(reply.writeErrors)) {
        for (const err of reply.writeErrors) {
          const op = batch.ops[err.index];
          writeErrors.push(new WriteError({ index: op.index, code: err.code, errmsg: err.errmsg, errInfo: err.errInfo, op: op.payload }));
        }
        if (ordered && reply.writeErrors.length) stop = true;
      }
      if (reply.writeConcernError) writeConcernError = reply.writeConcernError;
    }

    // Only documents that were written are reported: an ordered run stops
    // at its first failure, an unordered one skips the failed ones.
    const firstError = writeErrors.length ? Math.min(...writeErrors.map((e) => e.index)) : Infinity;
    const failedIndexes = new Set(writeErrors.map((e) => e.index));
    for (const entry of inserted) {
      if (ordered ? entry.index < firstError : !failedIndexes.has(entry.index)) state.insertedIds[entry.key] = entry._id;
    }

    const acknowledged = !(writeConcern && writeConcern.w === 0);
    if (writeErrors.length) {
      const first = writeErrors[0];
      throw new MongoBulkWriteError(first.errmsg, { code: first.code, writeErrors }, new DriverBulkWriteResult(state));
    }
    if (writeConcernError) {
      throw new MongoBulkWriteError(writeConcernError.errmsg, { code: writeConcernError.code, writeConcernError }, new DriverBulkWriteResult(state));
    }
    return new BulkWriteResult(acknowledged, state);
  }

  /** Raise the first write error of a single-statement write as the driver does. */
  function throwSingleWriteError(reply) {
    if (Array.isArray(reply.writeErrors) && reply.writeErrors.length) {
      const first = reply.writeErrors[0];
      throw new MongoServerError(first.errmsg, first);
    }
    if (reply.writeConcernError) {
      throw new MongoWriteConcernError(reply.writeConcernError.errmsg, Object.assign({}, reply.writeConcernError, { result: reply }));
    }
  }

  // ------------------------------------------------------------------
  // Collection
  // ------------------------------------------------------------------

  class Collection {
    constructor(mongo, database, name) {
      msh.hide(this, { _mongo: mongo, _database: database, _name: name });
    }

    [asPrintable]() {
      return `${this._database._name}.${this._name}`;
    }

    _run(cmd, opts) {
      return this._database._run(cmd, opts);
    }

    /** Explicit write concern, else the connection default (never inside a transaction). */
    _writeConcern(options) {
      if (this._database._inTransaction()) return undefined;
      if (options && options.writeConcern !== undefined) return options.writeConcern;
      return this._mongo._writeConcern || undefined;
    }

    _withWriteConcern(cmd, options) {
      const writeConcern = this._writeConcern(options);
      if (writeConcern !== undefined) cmd.writeConcern = writeConcern;
      return cmd;
    }

    _acknowledged(options) {
      const writeConcern = this._writeConcern(options);
      return !(writeConcern && writeConcern.w === 0);
    }

    // ---- reads ---------------------------------------------------------

    find(query, projection, options) {
      const opts = Object.assign({}, options);
      if (projection) opts.projection = projection;
      // The most recently created cursor is the one `it` continues.
      return (msh.currentCursor = new msh.Cursor(this._mongo, this, query, opts));
    }

    findOne(query, projection, options) {
      const opts = Object.assign({}, options);
      if (projection) opts.projection = projection;
      const cursor = new msh.Cursor(this._mongo, this, query, opts);
      cursor._options.limit = 1;
      cursor._options.singleBatch = true;
      delete cursor._options.batchSize;
      return cursor.next();
    }

    aggregate(...args) {
      let pipeline, options;
      if (args.length === 0 || Array.isArray(args[0])) {
        pipeline = args[0] || [];
        options = args[1] || {};
      } else {
        // Legacy form: aggregate(stage1, stage2, ...)
        pipeline = args;
        options = {};
      }
      if ('background' in options) {
        throw msh.invalidInput('the background option is not supported for aggregate');
      }
      const { explain, ...rest } = options;
      const cursor = new msh.AggregationCursor(this._mongo, this._database, this._name, pipeline, rest);
      if (explain) return cursor.explain(explain);
      // A pipeline that writes ($out / $merge) runs immediately.
      if (cursor._hasWriteStage()) cursor.hasNext();
      return (msh.currentCursor = cursor);
    }

    count(query, options) {
      msh.deprecated('Collection.count() is deprecated. Use countDocuments or estimatedDocumentCount.');
      const cmd = Object.assign({ count: this._name, query: query || {} }, msh.pick(options, ['limit', 'skip', 'hint', 'maxTimeMS', 'collation', 'readConcern', 'comment']));
      return this._run(cmd, { read: true }).n;
    }

    countDocuments(query, options) {
      const opts = options || {};
      const pipeline = [{ $match: query || {} }];
      if (typeof opts.skip === 'number') pipeline.push({ $skip: opts.skip });
      if (typeof opts.limit === 'number') pipeline.push({ $limit: opts.limit });
      pipeline.push({ $group: { _id: 1, n: { $sum: 1 } } });
      const cursor = new msh.AggregationCursor(this._mongo, this._database, this._name, pipeline, msh.pick(opts, ['hint', 'maxTimeMS', 'collation', 'comment', 'readConcern']));
      const first = cursor.next();
      cursor.close();
      return first === null ? 0 : toNumber(first.n);
    }

    estimatedDocumentCount(options) {
      const cmd = Object.assign({ count: this._name }, msh.pick(options, ['maxTimeMS', 'comment', 'readConcern']));
      return this._run(cmd, { read: true }).n;
    }

    distinct(field, query, options) {
      const cmd = Object.assign({ distinct: this._name, key: field, query: query || {} }, msh.pick(options, ['collation', 'maxTimeMS', 'comment', 'readConcern', 'hint']));
      return this._run(cmd, { read: true }).values;
    }

    // ---- writes --------------------------------------------------------

    insertOne(doc, options) {
      msh.required([doc], 1, 'Collection.insertOne');
      // Like mongosh, work on a copy: the caller's object is left untouched.
      doc = ensureId(copyDoc(doc));
      const cmd = Object.assign({ insert: this._name, documents: [doc], ordered: true }, msh.pick(options, ['bypassDocumentValidation', 'comment']));
      const reply = this._run(this._withWriteConcern(cmd, options));
      throwSingleWriteError(reply);
      return new InsertOneResult(this._acknowledged(options), doc._id);
    }

    insertMany(docs, options) {
      msh.required([docs], 1, 'Collection.insertMany');
      if (!Array.isArray(docs)) throw new MongoInvalidArgumentError('Argument "docs" must be an array of documents');
      const ops = docs.map((doc, index) => ({ type: 'insert', payload: ensureId(copyDoc(doc)), index }));
      const result = executeBulk(this, ops, options);
      return new InsertManyResult(result.acknowledged, result.insertedIds);
    }

    insert(docs, options) {
      msh.deprecated('Collection.insert() is deprecated. Use insertOne, insertMany, or bulkWrite.');
      msh.required([docs], 1, 'Collection.insert');
      const list = Array.isArray(docs) ? docs : [docs];
      const ops = list.map((doc, index) => ({ type: 'insert', payload: ensureId(copyDoc(doc)), index }));
      const result = executeBulk(this, ops, options);
      return new InsertManyResult(result.acknowledged, result.insertedIds);
    }

    _updateStatement(filter, update, options, multi) {
      return Object.assign({ q: filter, u: update }, msh.pick(options, ['upsert', 'arrayFilters', 'collation', 'hint', 'sort']), multi ? { multi: true } : {});
    }

    _update(filter, update, options, multi) {
      const cmd = Object.assign(
        { update: this._name, updates: [this._updateStatement(filter, update, options, multi)], ordered: true },
        msh.pick(options, ['bypassDocumentValidation', 'let', 'comment', 'maxTimeMS']),
      );
      const reply = this._run(this._withWriteConcern(cmd, options));
      throwSingleWriteError(reply);
      const upserted = Array.isArray(reply.upserted) ? reply.upserted : [];
      return new UpdateResult(
        this._acknowledged(options),
        toNumber(reply.n) - upserted.length,
        toNumber(reply.nModified),
        upserted.length,
        upserted.length ? upserted[0]._id : null,
      );
    }

    updateOne(filter, update, options) {
      msh.required([filter, update], 2, 'Collection.updateOne');
      assertUpdate(update);
      return this._update(filter, update, options, false);
    }

    updateMany(filter, update, options) {
      msh.required([filter, update], 2, 'Collection.updateMany');
      assertUpdate(update);
      return this._update(filter, update, options, true);
    }

    replaceOne(filter, replacement, options) {
      msh.required([filter, replacement], 2, 'Collection.replaceOne');
      assertReplacement(replacement);
      return this._update(filter, replacement, options, false);
    }

    update(filter, update, options) {
      msh.deprecated('Collection.update() is deprecated. Use updateOne, updateMany, or bulkWrite.');
      msh.required([filter, update], 2, 'Collection.update');
      const opts = options || {};
      return opts.multi ? this.updateMany(filter, update, opts) : this.updateOne(filter, update, opts);
    }

    _delete(filter, options, limit) {
      const statement = Object.assign({ q: filter, limit }, msh.pick(options, ['collation', 'hint']));
      const cmd = Object.assign({ delete: this._name, deletes: [statement], ordered: true }, msh.pick(options, ['let', 'comment', 'maxTimeMS']));
      const reply = this._run(this._withWriteConcern(cmd, options));
      throwSingleWriteError(reply);
      return new DeleteResult(this._acknowledged(options), toNumber(reply.n));
    }

    deleteOne(filter, options) {
      msh.required([filter], 1, 'Collection.deleteOne');
      if (options && options.explain) return this._explainDelete(filter, options, 1);
      return this._delete(filter, options, 1);
    }

    deleteMany(filter, options) {
      msh.required([filter], 1, 'Collection.deleteMany');
      if (options && options.explain) return this._explainDelete(filter, options, 0);
      return this._delete(filter, options, 0);
    }

    _explainDelete(filter, options, limit) {
      const statement = Object.assign({ q: filter, limit }, msh.pick(options, ['collation', 'hint']));
      return this._run({ explain: { delete: this._name, deletes: [statement] }, verbosity: msh.explainVerbosity(options.explain) });
    }

    remove(query, options) {
      msh.deprecated('Collection.remove() is deprecated. Use deleteOne, deleteMany, findOneAndDelete, or bulkWrite.');
      msh.required([query], 1, 'Collection.remove');
      let removeOptions = {};
      if (typeof options === 'boolean') removeOptions.justOne = options;
      else if (options) removeOptions = options;
      return removeOptions.justOne ? this.deleteOne(query, removeOptions) : this.deleteMany(query, removeOptions);
    }

    bulkWrite(operations, options) {
      msh.required([operations], 1, 'Collection.bulkWrite');
      if (!Array.isArray(operations)) throw new MongoInvalidArgumentError('Argument "operations" must be an array of documents');
      const ops = operations.map((operation, index) => {
        const name = operation && typeof operation === 'object' ? Object.keys(operation)[0] : undefined;
        const spec = name ? operation[name] : undefined;
        if (spec === null || typeof spec !== 'object') {
          throw new MongoInvalidArgumentError('Operation must be an object with an operation key');
        }
        const statementOptions = msh.pick(spec, ['upsert', 'arrayFilters', 'collation', 'hint', 'sort']);
        switch (name) {
          case 'insertOne':
            return { type: 'insert', payload: ensureId(spec.document !== undefined ? spec.document : spec), index };
          case 'updateOne':
            assertUpdate(spec.update);
            return { type: 'update', payload: Object.assign({ q: spec.filter, u: spec.update }, statementOptions), index };
          case 'updateMany':
            assertUpdate(spec.update);
            return { type: 'update', payload: Object.assign({ q: spec.filter, u: spec.update, multi: true }, statementOptions), index };
          case 'replaceOne':
            assertReplacement(spec.replacement);
            return { type: 'update', payload: Object.assign({ q: spec.filter, u: spec.replacement }, statementOptions), index };
          case 'deleteOne':
            return { type: 'delete', payload: Object.assign({ q: spec.filter, limit: 1 }, msh.pick(spec, ['collation', 'hint'])), index };
          case 'deleteMany':
            return { type: 'delete', payload: Object.assign({ q: spec.filter, limit: 0 }, msh.pick(spec, ['collation', 'hint'])), index };
          default:
            throw new MongoInvalidArgumentError('bulkWrite only supports insertOne, updateOne, updateMany, deleteOne, deleteMany');
        }
      });
      return executeBulk(this, ops, options);
    }

    // ---- find and modify -----------------------------------------------

    _findAndModify(query, body, options) {
      const cmd = Object.assign(
        { findAndModify: this._name, query: query || {} },
        body,
        msh.pick(options, ['sort', 'upsert', 'arrayFilters', 'collation', 'hint', 'maxTimeMS', 'bypassDocumentValidation', 'let', 'comment']),
      );
      const fields = options.projection !== undefined ? options.projection : options.fields;
      if (fields !== undefined) cmd.fields = fields;
      if (cmd.sort !== undefined) cmd.sort = msh.formatSort(cmd.sort);
      const reply = this._run(this._withWriteConcern(cmd, options));
      return reply.value === undefined ? null : reply.value;
    }

    _explainFindAndModify(query, body, options) {
      const cmd = Object.assign({ findAndModify: this._name, query: query || {} }, body, msh.pick(options, ['sort', 'upsert', 'arrayFilters', 'collation', 'hint']));
      return this._run({ explain: cmd, verbosity: msh.explainVerbosity(options.explain) });
    }

    findOneAndDelete(filter, options) {
      msh.required([filter], 1, 'Collection.findOneAndDelete');
      const opts = findAndModifyOptions(options);
      if (opts.explain) return this._explainFindAndModify(filter, { remove: true }, opts);
      return this._findAndModify(filter, { remove: true }, opts);
    }

    findOneAndReplace(filter, replacement, options) {
      msh.required([filter], 1, 'Collection.findOneAndReplace');
      assertReplacement(replacement);
      const opts = findAndModifyOptions(options);
      const body = { update: replacement, new: opts.returnDocument === 'after' };
      if (opts.explain) return this._explainFindAndModify(filter, body, opts);
      return this._findAndModify(filter, body, opts);
    }

    findOneAndUpdate(filter, update, options) {
      msh.required([filter], 1, 'Collection.findOneAndUpdate');
      assertUpdate(update);
      const opts = findAndModifyOptions(options);
      const body = { update, new: opts.returnDocument === 'after' };
      if (opts.explain) return this._explainFindAndModify(filter, body, opts);
      return this._findAndModify(filter, body, opts);
    }

    findAndModify(options) {
      msh.required([options], 1, 'Collection.findAndModify');
      if (options === null || typeof options !== 'object' || options.query === undefined) {
        throw msh.invalidInput('Missing required property: "query"');
      }
      const reduced = Object.assign({}, options);
      delete reduced.query;
      delete reduced.update;
      if (options.remove) return this.findOneAndDelete(options.query, reduced);
      const { update } = options;
      if (!update) throw msh.invalidInput('Must specify options.update or options.remove');
      if (hasAtomicOperators(update)) return this.findOneAndUpdate(options.query, update, reduced);
      return this.findOneAndReplace(options.query, update, reduced);
    }

    // ---- indexes -------------------------------------------------------

    createIndexes(keyPatterns, options, commitQuorum) {
      msh.required([keyPatterns], 1, 'Collection.createIndexes');
      if (typeof options !== 'object' && options !== undefined) throw msh.invalidInput('The "options" argument must be an object.');
      if (!Array.isArray(keyPatterns)) throw msh.invalidInput('The "keyPatterns" argument must be an array.');
      const indexes = keyPatterns.map((key) => {
        const spec = Object.assign({ key }, options);
        if (spec.name === undefined) spec.name = generateIndexName(key);
        return Object.assign({ key: spec.key, name: spec.name }, spec);
      });
      const cmd = { createIndexes: this._name, indexes };
      if (commitQuorum !== undefined) cmd.commitQuorum = commitQuorum;
      this._run(this._withWriteConcern(cmd));
      return indexes.map((index) => index.name);
    }

    createIndex(keys, options, commitQuorum) {
      msh.required([keys], 1, 'Collection.createIndex');
      if (typeof options !== 'object' && options !== undefined) throw msh.invalidInput('The "options" argument must be an object.');
      return this.createIndexes([keys], options, commitQuorum)[0];
    }

    ensureIndex(keys, options, commitQuorum) {
      msh.required([keys], 1, 'Collection.ensureIndex');
      if (typeof options !== 'object' && options !== undefined) throw msh.invalidInput('The "options" argument must be an object.');
      return this.createIndexes([keys], options, commitQuorum);
    }

    getIndexes() {
      return new msh.RunCommandCursor(this._mongo, this._database, { listIndexes: this._name, cursor: {} }).toArray();
    }

    getIndexKeys() {
      return this.getIndexes().map((index) => index.key);
    }

    dropIndexes(indexes) {
      if (indexes === undefined) indexes = '*';
      return this._run({ dropIndexes: this._name, index: indexes });
    }

    dropIndex(index) {
      msh.required([index], 1, 'Collection.dropIndex');
      if (index === '*') {
        throw msh.invalidInput("To drop indexes in the collection using '*', use db.collection.dropIndexes().");
      }
      if (Array.isArray(index)) {
        throw msh.invalidInput('The index to drop must be either the index name or the index specification document.');
      }
      return this._run({ dropIndexes: this._name, index });
    }

    _setIndexHidden(index, hidden) {
      const indexSpec = typeof index === 'string' ? { name: index, hidden } : { keyPattern: index, hidden };
      return this._run({ collMod: this._name, index: indexSpec });
    }

    hideIndex(index) {
      msh.required([index], 1, 'Collection.hideIndex');
      return this._setIndexHidden(index, true);
    }

    unhideIndex(index) {
      msh.required([index], 1, 'Collection.unhideIndex');
      return this._setIndexHidden(index, false);
    }

    totalIndexSize(...args) {
      if (args.length) throw msh.invalidInput('"totalIndexSize" takes no argument. Use db.collection.stats to get detailed information.');
      return this.stats().totalIndexSize;
    }

    reIndex() {
      return this._run({ reIndex: this._name });
    }

    getSearchIndexes(indexName, options) {
      if (typeof indexName === 'object' && indexName !== null) {
        options = indexName;
        indexName = undefined;
      }
      const stage = indexName === undefined ? {} : { name: indexName };
      return new msh.AggregationCursor(this._mongo, this._database, this._name, [{ $listSearchIndexes: stage }], options || {}).toArray();
    }

    createSearchIndex(nameOrOptions, typeOrOptions, definition) {
      let spec;
      if (typeof nameOrOptions === 'object' && nameOrOptions !== null) {
        spec = nameOrOptions;
      } else if (typeof typeOrOptions === 'string') {
        spec = { name: nameOrOptions || 'default', type: typeOrOptions, definition: Object.assign({}, definition) };
      } else {
        spec = { name: nameOrOptions || 'default', definition: Object.assign({}, typeOrOptions) };
      }
      return this.createSearchIndexes([spec])[0];
    }

    createSearchIndexes(specs) {
      msh.required([specs], 1, 'Collection.createSearchIndexes');
      const reply = this._run({ createSearchIndexes: this._name, indexes: specs });
      return (reply.indexesCreated || []).map((index) => index.name);
    }

    dropSearchIndex(indexName) {
      msh.required([indexName], 1, 'Collection.dropSearchIndex');
      this._run({ dropSearchIndex: this._name, name: indexName });
    }

    updateSearchIndex(indexName, definition) {
      msh.required([indexName, definition], 2, 'Collection.updateSearchIndex');
      this._run({ updateSearchIndex: this._name, name: indexName, definition });
    }

    // ---- collection management ------------------------------------------

    getDB() {
      return this._database;
    }

    getMongo() {
      return this._mongo;
    }

    getName() {
      return this._name;
    }

    getFullName() {
      return `${this._database._name}.${this._name}`;
    }

    drop(options) {
      try {
        this._run(Object.assign({ drop: this._name }, msh.pick(options, ['writeConcern', 'comment'])));
        return true;
      } catch (error) {
        if (error && (error.codeName === 'NamespaceNotFound' || error.code === 26)) return false;
        throw error;
      }
    }

    exists() {
      const infos = this._database.getCollectionInfos({ name: this._name });
      return infos[0] || null;
    }

    isCapped() {
      const infos = this._database.getCollectionInfos({ name: this._name });
      return !!(infos[0] && infos[0].options && infos[0].options.capped);
    }

    renameCollection(newName, dropTarget) {
      msh.assertArgs([newName], [['string']], 'Collection.renameCollection');
      const db = this._database._name;
      try {
        this._mongo._run('admin', { renameCollection: `${db}.${this._name}`, to: `${db}.${newName}`, dropTarget: !!dropTarget }, { session: this._database._sessionHandle() });
        return { ok: 1 };
      } catch (error) {
        if (error && error.name === 'MongoError') {
          return { ok: 0, errmsg: error.errmsg, code: error.code, codeName: error.codeName };
        }
        throw error;
      }
    }

    convertToCapped(size) {
      msh.required([size], 1, 'Collection.convertToCapped');
      return this._run({ convertToCapped: this._name, size });
    }

    runCommand(commandName, options) {
      msh.required([commandName], 1, 'Collection.runCommand');
      if (options) {
        if (typeof commandName !== 'string') {
          throw msh.invalidInput('Collection.runCommand takes a command string as its first arugment');
        } else if (commandName in options) {
          throw msh.invalidInput('The "commandName" argument cannot be passed as an option to "runCommand".');
        }
      }
      const cmd = typeof commandName === 'string' ? Object.assign({ [commandName]: this._name }, options) : commandName;
      return this._run(cmd);
    }

    validate(options) {
      const opts = typeof options === 'boolean' ? { full: options } : options || {};
      return this._run(Object.assign({ validate: this._name }, opts));
    }

    compactStructuredEncryptionData() {
      return this._run({ compactStructuredEncryptionData: this._name });
    }

    // ---- statistics ----------------------------------------------------

    /** $collStats merged across shards into the classic collStats shape. */
    _aggregatedStats(scale) {
      const stats = new msh.AggregationCursor(this._mongo, this._database, this._name, [{ $collStats: { storageStats: { scale: 1 } } }], {}).toArray();
      if (!stats.length) throw new MongoshRuntimeError(`Error running $collStats aggregation stage on ${this.getFullName()}`, 'SHAPI-10004');
      const result = { ok: 1 };
      const counts = {};
      const indexSizes = {};
      const shardStats = {};
      const nindexes = [];
      let maxSize = 0;
      let unscaledSize = 0;
      if (stats[0].shard) result.shards = shardStats;
      const additive = ['count', 'size', 'storageSize', 'totalIndexSize', 'totalSize', 'numOrphanDocs'];
      const fromFirstShard = ['userFlags', 'capped', 'max', 'paddingFactorNote', 'indexDetails', 'wiredTiger'];
      const scaled = ['size', 'storageSize', 'totalIndexSize', 'totalSize'];

      for (const shard of stats) {
        const storage = shard.storageStats || {};
        const objects = storage.count !== undefined ? toNumber(storage.count) : 0;
        for (const field of Object.keys(storage)) {
          if (['ns', 'ok', 'lastExtentSize', 'paddingFactor'].includes(field)) continue;
          if (fromFirstShard.includes(field)) {
            if (result[field] === undefined) result[field] = storage[field];
          } else if (additive.includes(field)) {
            counts[field] = (counts[field] || 0) + toNumber(storage[field]);
          } else if (field === 'avgObjSize') {
            unscaledSize += toNumber(storage[field]) * objects;
          } else if (field === 'maxSize') {
            maxSize = Math.max(maxSize, toNumber(storage[field]));
          } else if (field === 'indexSizes') {
            for (const name of Object.keys(storage.indexSizes)) {
              indexSizes[name] = (indexSizes[name] || 0) + toNumber(storage.indexSizes[name]);
            }
          } else if (field === 'nindexes') {
            nindexes.push(toNumber(storage[field]));
          }
        }
        if (shard.shard) {
          const copy = Object.assign({}, storage);
          for (const field of scaled) if (copy[field] !== undefined) copy[field] = toNumber(copy[field]) / scale;
          if (copy.indexSizes) {
            copy.indexSizes = Object.fromEntries(Object.entries(copy.indexSizes).map(([k, v]) => [k, toNumber(v) / scale]));
          }
          shardStats[shard.shard] = copy;
        }
      }

      const ns = this.getFullName();
      let sharded = false;
      try {
        sharded = this._mongo._run('config', { count: 'collections', query: { _id: ns, dropped: { $ne: true } } }, {}).n > 0;
      } catch { /* not allowed to read config: report as unsharded */ }
      result.sharded = sharded;
      for (const [field, count] of Object.entries(counts)) {
        result[field] = scaled.includes(field) ? count / scale : count;
      }
      result.indexSizes = {};
      for (const [name, size] of Object.entries(indexSizes)) result.indexSizes[name] = size / scale;
      result.avgObjSize = counts.count > 0 ? unscaledSize / counts.count : 0;
      if (result.capped) result.maxSize = maxSize / scale;
      result.ns = ns;
      result.nindexes = nindexes.length ? Math.max(...nindexes) : 0;
      result.scaleFactor = scale;
      return result;
    }

    stats(originalOptions) {
      const options = typeof originalOptions === 'number' ? { scale: originalOptions } : Object.assign({}, originalOptions);
      if (options.indexDetailsKey && options.indexDetailsName) {
        throw msh.invalidInput('Cannot filter indexDetails on both indexDetailsKey and indexDetailsName');
      }
      if (options.indexDetailsKey && typeof options.indexDetailsKey !== 'object') {
        throw msh.invalidInput(`Expected options.indexDetailsKey to be a document, got ${typeof options.indexDetailsKey}`);
      }
      if (options.indexDetailsName && typeof options.indexDetailsName !== 'string') {
        throw msh.invalidInput(`Expected options.indexDetailsName to be a string, got ${typeof options.indexDetailsName}`);
      }
      const scale = options.scale || 1;
      const result = this._aggregatedStats(scale);
      if (!options.indexDetails) {
        delete result.indexDetails;
        if (result.shards) for (const shard of Object.values(result.shards)) delete shard.indexDetails;
      }
      return result;
    }

    dataSize() {
      return this.stats().size;
    }

    storageSize() {
      return this.stats().storageSize;
    }

    totalSize() {
      const stats = this.stats();
      return (Number(stats.storageSize) || 0) + (Number(stats.totalIndexSize) || 0);
    }

    latencyStats(options) {
      return new msh.AggregationCursor(this._mongo, this._database, this._name, [{ $collStats: { latencyStats: options || {} } }], {}).toArray();
    }

    // ---- everything else -------------------------------------------------

    explain(verbosity) {
      return new Explainable(this._mongo, this, msh.explainVerbosity(verbosity));
    }

    initializeOrderedBulkOp() {
      return new Bulk(this, true);
    }

    initializeUnorderedBulkOp() {
      return new Bulk(this, false);
    }

    getPlanCache() {
      return new PlanCache(this);
    }

    mapReduce(map, reduce, optionsOrOutString) {
      msh.required([map, reduce, optionsOrOutString], 3, 'Collection.mapReduce');
      msh.deprecated('Collection.mapReduce() is deprecated. Use an aggregation instead.\nSee https://mongodb.com/docs/manual/core/map-reduce for details.');
      const options = typeof optionsOrOutString === 'string' ? { out: optionsOrOutString } : Object.assign({}, optionsOrOutString);
      if (options.out === undefined) throw msh.invalidInput("Missing 'out' option");
      const cmd = Object.assign({ mapReduce: this._name, map: new Code(map), reduce: new Code(reduce) }, options);
      if (cmd.finalize !== undefined && typeof cmd.finalize !== 'object') cmd.finalize = new Code(cmd.finalize);
      return this._run(cmd);
    }

    watch(pipeline, options) {
      if (pipeline === undefined) pipeline = [];
      else if (!Array.isArray(pipeline)) {
        options = pipeline;
        pipeline = [];
      }
      const cursor = new msh.ChangeStreamCursor(this._mongo, this._database, this._name, pipeline, options || {}, this._name);
      // Open the stream now so events from this point on are captured.
      cursor._cursor().start();
      return (msh.currentCursor = cursor);
    }

    getShardVersion() {
      return this._mongo._run('admin', { getShardVersion: this.getFullName() }, {});
    }

    getShardDistribution() {
      const ns = this.getFullName();
      const config = this._mongo.getDB('config');
      const collStats = new msh.AggregationCursor(this._mongo, this._database, this._name, [{ $collStats: { storageStats: {} } }], {}).toArray();
      const uuid = (() => {
        const entry = config.getCollection('collections').findOne({ _id: ns, dropped: { $ne: true } });
        return entry ? entry.uuid : undefined;
      })();
      if (uuid === undefined && !collStats.some((s) => s.shard)) {
        throw new MongoshInvalidInputError(`Collection ${this._name} is not sharded`, 'SHAPI-10001');
      }
      const result = {};
      const totals = { numChunks: 0, size: 0, count: 0 };
      const shardRows = [];
      for (const shard of collStats) {
        if (!shard.shard) continue;
        const storage = shard.storageStats || {};
        const chunkQuery = uuid !== undefined ? { uuid, shard: shard.shard } : { ns, shard: shard.shard };
        const numChunks = config.getCollection('chunks').countDocuments(chunkQuery);
        const size = toNumber(storage.size);
        const count = toNumber(storage.count);
        const avgObjSize = toNumber(storage.avgObjSize);
        const host = (config.getCollection('shards').findOne({ _id: shard.shard }) || {}).host;
        const estChunkData = numChunks === 0 ? 0 : size / numChunks;
        const estChunkCount = numChunks === 0 ? 0 : Math.floor(count / numChunks);
        result[`Shard ${shard.shard} at ${host}`] = {
          data: msh.dataFormat(size),
          docs: count,
          chunks: numChunks,
          'estimated data per chunk': msh.dataFormat(estChunkData),
          'estimated docs per chunk': estChunkCount,
        };
        totals.size += size;
        totals.count += count;
        totals.numChunks += numChunks;
        shardRows.push({ shard: shard.shard, size, count, avgObjSize });
      }
      const totalValue = { data: msh.dataFormat(totals.size), docs: totals.count, chunks: totals.numChunks };
      for (const row of shardRows) {
        const dataPct = totals.size === 0 ? 0 : Math.floor((row.size / totals.size) * 10000) / 100;
        const docsPct = totals.count === 0 ? 0 : Math.floor((row.count / totals.count) * 10000) / 100;
        totalValue[`Shard ${row.shard}`] = [`${dataPct} % data`, `${docsPct} % docs in cluster`, `${msh.dataFormat(row.avgObjSize)} avg obj size on shard`];
      }
      result.Totals = totalValue;
      return result;
    }

    getShardLocation() {
      const ns = this.getFullName();
      const config = this._mongo.getDB('config');
      const entry = config.getCollection('collections').findOne({ _id: ns, dropped: { $ne: true } });
      if (entry && !entry.unsplittable) {
        const filter = entry.uuid !== undefined ? { uuid: entry.uuid } : { ns };
        return { shards: config.getCollection('chunks').distinct('shard', filter), sharded: true };
      }
      const dbEntry = config.getCollection('databases').findOne({ _id: this._database._name });
      return { shards: dbEntry && dbEntry.primary ? [dbEntry.primary] : [], sharded: false };
    }

    analyzeShardKey(key, options) {
      msh.required([key], 1, 'Collection.analyzeShardKey');
      return this._mongo._run('admin', Object.assign({ analyzeShardKey: this.getFullName(), key }, options), {});
    }

    configureQueryAnalyzer(options) {
      msh.required([options], 1, 'Collection.configureQueryAnalyzer');
      return this._mongo._run('admin', Object.assign({ configureQueryAnalyzer: this.getFullName() }, options), {});
    }

    checkMetadataConsistency(options) {
      return new msh.RunCommandCursor(this._mongo, this._database, Object.assign({ checkMetadataConsistency: this._name }, options));
    }
  }
  Collection.prototype.getIndexSpecs = Collection.prototype.getIndexes;
  Collection.prototype.getIndices = Collection.prototype.getIndexes;

  msh.describeClass(Collection, {
    type: 'Collection',
    help: 'Collection Class',
    prefix: 'Collection',
    docs: `${msh.docs.manual}/js-collection`,
    methods: {
      aggregate: 'Runs an aggregation pipeline over the collection and returns a cursor.',
      bulkWrite: 'Runs a list of insert, update, replace and delete operations in one call.',
      count: 'Deprecated. Counts documents matching a query; use countDocuments instead.',
      countDocuments: 'Counts the documents that match a query.',
      deleteMany: 'Deletes every document that matches the filter.',
      deleteOne: 'Deletes the first document that matches the filter.',
      distinct: 'Returns the distinct values of a field among matching documents.',
      estimatedDocumentCount: 'Returns a fast count of all documents from collection metadata.',
      find: 'Returns a cursor over the documents that match a query.',
      findAndModify: 'Finds one document and updates, replaces or removes it, returning it.',
      findOne: 'Returns the first document that matches a query, or null.',
      renameCollection: 'Renames the collection, optionally dropping an existing target.',
      findOneAndDelete: 'Deletes one matching document and returns it.',
      findOneAndReplace: 'Replaces one matching document and returns the old or new version.',
      findOneAndUpdate: 'Updates one matching document and returns the old or new version.',
      insert: 'Deprecated. Inserts one or more documents; use insertOne or insertMany.',
      insertMany: 'Inserts an array of documents.',
      insertOne: 'Inserts a single document.',
      isCapped: 'Returns true if the collection is capped.',
      remove: 'Deprecated. Removes matching documents; use deleteOne or deleteMany.',
      replaceOne: 'Replaces the first document that matches the filter.',
      update: 'Deprecated. Updates matching documents; use updateOne or updateMany.',
      updateMany: 'Applies an update to every document that matches the filter.',
      updateOne: 'Applies an update to the first document that matches the filter.',
      compactStructuredEncryptionData: 'Compacts the metadata of a Queryable Encryption collection.',
      convertToCapped: 'Converts the collection to a capped collection of the given size in bytes.',
      createIndexes: 'Creates one index per key pattern in the given array.',
      createIndex: 'Creates an index on the given key pattern.',
      ensureIndex: 'Deprecated alias of createIndex.',
      getIndexes: 'Returns the index definitions of the collection.',
      getIndexSpecs: 'Alias of getIndexes.',
      getIndices: 'Alias of getIndexes.',
      getIndexKeys: 'Returns the key pattern of each index.',
      dropIndexes: 'Drops the given indexes, or all but the _id index when called without arguments.',
      dropIndex: 'Drops one index by name or key pattern.',
      totalIndexSize: 'Returns the total size of all indexes in bytes.',
      reIndex: 'Rebuilds all indexes on a standalone server.',
      getDB: 'Returns the database this collection belongs to.',
      getMongo: 'Returns the connection this collection uses.',
      dataSize: 'Returns the uncompressed size of the documents in bytes.',
      storageSize: 'Returns the storage allocated to the collection in bytes.',
      totalSize: 'Returns the storage size plus the total index size in bytes.',
      drop: 'Drops the collection and its indexes.',
      exists: 'Returns the collection info document if the collection exists, otherwise null.',
      getFullName: 'Returns the namespace as database.collection.',
      getName: 'Returns the collection name.',
      runCommand: 'Runs a database command with the collection name as its target.',
      explain: 'Returns an object whose methods explain an operation instead of running it.',
      stats: 'Returns storage and index statistics for the collection.',
      latencyStats: 'Returns read, write and command latency histograms.',
      initializeOrderedBulkOp: 'Starts a bulk operation whose writes run in order and stop on the first error.',
      initializeUnorderedBulkOp: 'Starts a bulk operation whose writes may run in any order.',
      getPlanCache: 'Returns an interface to the query plan cache of the collection.',
      mapReduce: 'Deprecated. Runs a map-reduce job; use an aggregation instead.',
      validate: 'Checks the collection data and indexes for correctness.',
      getShardVersion: 'Returns the shard version of the collection (sharded clusters).',
      getShardDistribution: 'Reports how the data of a sharded collection is spread across shards.',
      getShardLocation: 'Returns the shards that hold the collection.',
      watch: 'Opens a change stream on the collection.',
      hideIndex: 'Hides an index from the query planner.',
      unhideIndex: 'Makes a hidden index visible to the query planner again.',
      analyzeShardKey: 'Returns metrics for judging a shard key candidate.',
      configureQueryAnalyzer: 'Turns query sampling for the collection on or off.',
      checkMetadataConsistency: 'Returns a cursor over sharding metadata inconsistencies for the collection.',
      getSearchIndexes: 'Returns the Atlas Search indexes of the collection.',
      createSearchIndex: 'Creates one Atlas Search index.',
      createSearchIndexes: 'Creates several Atlas Search indexes.',
      dropSearchIndex: 'Drops an Atlas Search index by name.',
      updateSearchIndex: 'Replaces the definition of an Atlas Search index.',
    },
  });

  // ------------------------------------------------------------------
  // Explainable
  // ------------------------------------------------------------------

  class ExplainableCursor extends msh.Cursor {
    constructor(mongo, collection, filter, options, verbosity) {
      super(mongo, collection, filter, options);
      this._verbosity = verbosity;
      this._explained = null;
    }

    [asPrintable]() {
      if (this._explained === null) this._explained = this.explain(this._verbosity);
      return this._explained;
    }

    finish() {
      return this[asPrintable]();
    }
  }
  msh.describeClass(ExplainableCursor, { type: 'ExplainableCursor', help: 'Explainable Cursor', prefix: 'ExplainableCursor', methods: {} });

  class Explainable {
    constructor(mongo, collection, verbosity) {
      msh.hide(this, { _mongo: mongo, _collection: collection, _verbosity: verbosity });
    }

    [asPrintable]() {
      return `Explainable(${this._collection.getFullName()})`;
    }

    _explain(command) {
      return this._collection._run({ explain: command, verbosity: this._verbosity }, { read: true });
    }

    getCollection() {
      return this._collection;
    }

    getVerbosity() {
      return this._verbosity;
    }

    setVerbosity(verbosity) {
      this._verbosity = msh.explainVerbosity(verbosity);
    }

    find(query, projection, options) {
      const opts = Object.assign({}, options);
      if (projection) opts.projection = projection;
      return new ExplainableCursor(this._mongo, this._collection, query, opts, this._verbosity);
    }

    aggregate(...args) {
      let pipeline, options;
      if (args.length === 0 || Array.isArray(args[0])) {
        pipeline = args[0] || [];
        options = args[1] || {};
      } else {
        pipeline = args;
        options = {};
      }
      const { explain, ...rest } = options;
      return new msh.AggregationCursor(this._mongo, this._collection._database, this._collection._name, pipeline, rest).explain(this._verbosity);
    }

    count(query, options) {
      return this._explain(Object.assign({ count: this._collection._name, query: query || {} }, msh.pick(options, ['limit', 'skip', 'hint', 'maxTimeMS', 'collation'])));
    }

    distinct(field, query, options) {
      return this._explain(Object.assign({ distinct: this._collection._name, key: field, query: query || {} }, msh.pick(options, ['collation', 'maxTimeMS'])));
    }

    findAndModify(options) {
      return this._collection.findAndModify(Object.assign({}, options, { explain: this._verbosity }));
    }

    findOneAndDelete(filter, options) {
      return this._collection.findOneAndDelete(filter, Object.assign({}, options, { explain: this._verbosity }));
    }

    findOneAndReplace(filter, replacement, options) {
      return this._collection.findOneAndReplace(filter, replacement, Object.assign({}, options, { explain: this._verbosity }));
    }

    findOneAndUpdate(filter, update, options) {
      return this._collection.findOneAndUpdate(filter, update, Object.assign({}, options, { explain: this._verbosity }));
    }

    remove(query, options) {
      msh.deprecated('Collection.remove() is deprecated. Use deleteOne, deleteMany, findOneAndDelete, or bulkWrite.');
      const opts = typeof options === 'boolean' ? { justOne: options } : options || {};
      const statement = Object.assign({ q: query || {}, limit: opts.justOne ? 1 : 0 }, msh.pick(opts, ['collation', 'hint']));
      return this._explain({ delete: this._collection._name, deletes: [statement] });
    }

    update(filter, update, options) {
      msh.deprecated('Collection.update() is deprecated. Use updateOne, updateMany, or bulkWrite.');
      const opts = options || {};
      const statement = this._collection._updateStatement(filter, update, opts, !!opts.multi);
      return this._explain({ update: this._collection._name, updates: [statement] });
    }

    mapReduce(map, reduce, optionsOrOutString) {
      const options = typeof optionsOrOutString === 'string' ? { out: optionsOrOutString } : Object.assign({}, optionsOrOutString);
      return this._explain(Object.assign({ mapReduce: this._collection._name, map: new Code(map), reduce: new Code(reduce) }, options));
    }
  }

  msh.describeClass(Explainable, {
    type: 'Explainable',
    help: 'Explainable Class',
    prefix: 'Explainable',
    docs: `${msh.docs.manual}/db.collection.explain`,
    methods: {
      getCollection: 'Returns the collection being explained.',
      getVerbosity: 'Returns the current explain verbosity.',
      setVerbosity: 'Sets the explain verbosity: queryPlanner, executionStats or allPlansExecution.',
      find: 'Explains a find. Cursor modifiers such as sort() and limit() can be chained.',
      aggregate: 'Explains an aggregation pipeline.',
      count: 'Explains a count.',
      distinct: 'Explains a distinct.',
      findAndModify: 'Explains a findAndModify.',
      findOneAndDelete: 'Explains a findOneAndDelete.',
      findOneAndReplace: 'Explains a findOneAndReplace.',
      findOneAndUpdate: 'Explains a findOneAndUpdate.',
      remove: 'Explains a delete.',
      update: 'Explains an update.',
      mapReduce: 'Explains a map-reduce job.',
    },
  });

  // ------------------------------------------------------------------
  // Legacy Bulk API
  // ------------------------------------------------------------------

  class BulkFindOp {
    constructor(bulk, selector) {
      msh.hide(this, { _bulk: bulk, _selector: selector, _statement: {} });
    }

    [asPrintable]() {
      return 'BulkFindOp';
    }

    _push(type, payload) {
      this._bulk._ops.push({ type, payload: Object.assign(payload, this._statement), index: this._bulk._ops.length });
      return this._bulk;
    }

    collation(spec) {
      this._statement.collation = spec;
      return this;
    }

    arrayFilters(filters) {
      this._statement.arrayFilters = filters;
      return this;
    }

    hint(hintDoc) {
      this._statement.hint = hintDoc;
      return this;
    }

    upsert() {
      this._statement.upsert = true;
      return this;
    }

    delete() {
      return this._push('delete', { q: this._selector, limit: 0 });
    }

    deleteOne() {
      return this._push('delete', { q: this._selector, limit: 1 });
    }

    remove() {
      return this.delete();
    }

    removeOne() {
      return this.deleteOne();
    }

    replaceOne(replacement) {
      msh.required([replacement], 1, 'BulkFindOp.replaceOne');
      assertReplacement(replacement);
      return this._push('update', { q: this._selector, u: replacement });
    }

    updateOne(update) {
      msh.required([update], 1, 'BulkFindOp.updateOne');
      assertUpdate(update);
      return this._push('update', { q: this._selector, u: update });
    }

    update(update) {
      msh.required([update], 1, 'BulkFindOp.update');
      assertUpdate(update);
      return this._push('update', { q: this._selector, u: update, multi: true });
    }
  }
  msh.describeClass(BulkFindOp, {
    type: 'BulkFindOp',
    help: 'Bulk Find Operation',
    prefix: 'BulkFindOp',
    docs: `${msh.docs.manual}/js-bulk`,
    methods: {
      arrayFilters: 'Sets the array filters for the following update.',
      collation: 'Sets the collation for the following operation.',
      delete: 'Queues a delete of every matching document.',
      deleteOne: 'Queues a delete of the first matching document.',
      hint: 'Sets the index to use for the following operation.',
      remove: 'Alias of delete.',
      removeOne: 'Alias of deleteOne.',
      replaceOne: 'Queues a replacement of the first matching document.',
      updateOne: 'Queues an update of the first matching document.',
      update: 'Queues an update of every matching document.',
      upsert: 'Makes the following update or replace an upsert.',
    },
  });

  class Bulk {
    constructor(collection, ordered) {
      msh.hide(this, { _collection: collection, _ordered: ordered, _ops: [], _executed: false, _batches: [] });
    }

    [asPrintable]() {
      return this.toJSON();
    }

    toJSON() {
      const count = (type) => this._ops.filter((op) => op.type === type).length;
      return {
        nInsertOps: count('insert'),
        nUpdateOps: count('update'),
        nRemoveOps: count('delete'),
        nBatches: this._ops.length ? buildBatches(this._ops, this._ordered).length : 0,
      };
    }

    toString() {
      return JSON.stringify(this.toJSON());
    }

    insert(document) {
      msh.required([document], 1, 'Bulk.insert');
      this._ops.push({ type: 'insert', payload: ensureId(document), index: this._ops.length });
      return this;
    }

    find(query) {
      msh.required([query], 1, 'Bulk.find');
      return new BulkFindOp(this, query);
    }

    execute(writeConcern) {
      if (this._executed) throw new MongoBatchReExecutionError('This batch has already been executed, create new batch to execute');
      if (!this._ops.length) throw new MongoInvalidArgumentError('Invalid BulkOperation, Batch cannot be empty');
      this._batches = buildBatches(this._ops, this._ordered);
      this._executed = true;
      return executeBulk(this._collection, this._ops, { ordered: this._ordered, writeConcern });
    }

    getOperations() {
      if (!this._executed) throw new MongoshInvalidInputError('Cannot call getOperations on an unexecuted Bulk operation', 'COMMON-10002');
      const types = { insert: 1, update: 2, delete: 3 };
      return this._batches.map((batch) => ({
        originalZeroIndex: batch.ops[0].index,
        batchType: types[batch.type],
        operations: batch.ops.map((op) => op.payload),
      }));
    }
  }
  msh.describeClass(Bulk, {
    type: 'Bulk',
    help: 'Bulk Operations Builder',
    prefix: 'Bulk',
    docs: `${msh.docs.manual}/js-bulk`,
    methods: {
      insert: 'Queues an insert.',
      find: 'Selects the documents the next queued update or delete applies to.',
      execute: 'Runs the queued operations and returns a BulkWriteResult.',
      getOperations: 'Returns the batches that were sent, after execute().',
      toJSON: 'Returns the number of queued operations and batches.',
      toString: 'Returns toJSON() as a string.',
    },
  });

  // ------------------------------------------------------------------
  // Plan cache
  // ------------------------------------------------------------------

  class PlanCache {
    constructor(collection) {
      msh.hide(this, { _collection: collection });
    }

    [asPrintable]() {
      return `PlanCache for collection ${this._collection._name}.`;
    }

    clear() {
      return this._collection._run({ planCacheClear: this._collection._name });
    }

    clearPlansByQuery(query, projection, sort) {
      msh.required([query], 1, 'PlanCache.clearPlansByQuery');
      const cmd = { planCacheClear: this._collection._name, query };
      if (projection) cmd.projection = projection;
      if (sort) cmd.sort = sort;
      return this._collection._run(cmd);
    }

    list(pipeline) {
      const stages = [{ $planCacheStats: {} }, ...(pipeline || [])];
      return new msh.AggregationCursor(this._collection._mongo, this._collection._database, this._collection._name, stages, {}).toArray();
    }

    planCacheQueryShapes() {
      throw new msh.errors.MongoshDeprecatedError('PlanCache.listQueryShapes was deprecated, please use PlanCache.list instead', 'COMMON-10003');
    }

    getPlansByQuery() {
      throw new msh.errors.MongoshDeprecatedError('PlanCache.getPlansByQuery was deprecated, please use PlanCache.list instead', 'COMMON-10003');
    }
  }
  PlanCache.prototype.listQueryShapes = PlanCache.prototype.planCacheQueryShapes;
  msh.describeClass(PlanCache, {
    type: 'PlanCache',
    help: 'PlanCache Class',
    prefix: 'PlanCache',
    docs: `${msh.docs.manual}/js-plan-cache`,
    methods: {
      clear: 'Removes every cached plan of the collection.',
      clearPlansByQuery: 'Removes the cached plans for one query shape.',
      list: 'Returns the plan cache entries, optionally filtered by a pipeline.',
      listQueryShapes: 'Removed. Use list() instead.',
      getPlansByQuery: 'Removed. Use list() instead.',
    },
  });

  Object.assign(msh, {
    Collection, Explainable, ExplainableCursor, Bulk, BulkFindOp, PlanCache, WriteError,
    InsertOneResult, InsertManyResult, UpdateResult, DeleteResult, BulkWriteResult, executeBulk,
  });
})(globalThis);
