// The `sh` object: sharded cluster administration helpers.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const { asPrintable } = msh.symbols;
  const { MongoshInvalidInputError } = msh.errors;

  const SHARDED_ONLY = { $or: [{ unsplittable: { $exists: false } }, { unsplittable: false }] };
  const MAJORITY = (wtimeout) => ({ w: 'majority', wtimeout });

  /** config.chunks is keyed by collection uuid on 5.0+, by namespace before. */
  const chunksMatch = (collection) => (Object.prototype.hasOwnProperty.call(collection, 'timestamp')
    ? { uuid: collection.uuid }
    : { ns: collection._id });

  msh.dataFormat = function (bytes) {
    if (bytes === null || bytes === undefined) return '0B';
    if (bytes < 1024) return `${Math.floor(bytes)}B`;
    if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.floor((Math.floor(bytes / 1024) / 1024) * 100) / 100}MiB`;
    return `${Math.floor((Math.floor(bytes / (1024 * 1024)) / 1024) * 100) / 100}GiB`;
  };

  /** The data behind sh.status() / db.printShardingStatus(). */
  msh.getPrintableShardStatus = function (configDB, verbose) {
    const result = {};
    const mongosColl = configDB.getCollection('mongos');
    const chunksColl = configDB.getCollection('chunks');
    const settingsColl = configDB.getCollection('settings');
    const changelogColl = configDB.getCollection('changelog');

    const version = configDB.getCollection('version').findOne();
    if (version === null) {
      throw new MongoshInvalidInputError('This db does not have sharding enabled. Be sure you are connecting to a mongos from the shell and not to a mongod.', 'SHAPI-10003');
    }
    result.shardingVersion = version;
    result.shards = configDB.getCollection('shards').find().sort({ _id: 1 }).toArray();

    // A mongos counts as active if it pinged within the last minute.
    const activeThresholdMs = 60000;
    const mostRecent = mongosColl.find().sort({ ping: -1 }).limit(1).tryNext();
    let adjective = 'most recently active';
    let mostRecentTime = null;
    if (mostRecent !== null) {
      mostRecentTime = mostRecent.ping;
      if (mostRecentTime.getTime() >= Date.now() - activeThresholdMs) adjective = 'active';
    }
    const mongosKey = `${adjective} mongoses`;
    if (mostRecentTime === null) {
      result[mongosKey] = 'none';
    } else {
      const query = { ping: { $gt: new Date(mostRecentTime.getTime() - activeThresholdMs) } };
      if (verbose) {
        result[mongosKey] = mongosColl.find(query).sort({ ping: -1 }).toArray();
      } else {
        result[mongosKey] = mongosColl
          .aggregate([{ $match: query }, { $group: { _id: '$mongoVersion', num: { $sum: 1 } } }, { $sort: { num: -1 } }])
          .toArray()
          .map((entry) => ({ [entry._id]: entry.num }));
      }
    }

    const autosplit = settingsColl.findOne({ _id: 'autosplit' });
    result.autosplit = { 'Currently enabled': autosplit === null || autosplit.enabled ? 'yes' : 'no' };

    const balancer = {};
    const balancerSetting = settingsColl.findOne({ _id: 'balancer' });
    balancer['Currently enabled'] = balancerSetting === null || !balancerSetting.stopped ? 'yes' : 'no';
    let running = 'unknown';
    try {
      running = configDB.adminCommand({ balancerStatus: 1 }).inBalancerRound ? 'yes' : 'no';
    } catch { /* not allowed or not a mongos */ }
    balancer['Currently running'] = running;

    if (version.currentVersion === undefined || version.currentVersion > 5 || version.clusterId) {
      const rounds = configDB.getCollection('actionlog').find({ what: 'balancer.round' }).sort({ time: -1 }).limit(5).toArray();
      const report = { count: 0, lastErr: '', lastTime: ' ' };
      for (const round of rounds) {
        if (round.details && round.details.errorOccurred) {
          report.count += 1;
          if (report.count === 1) {
            report.lastErr = round.details.errmsg;
            report.lastTime = round.time;
          }
        }
      }
      balancer['Failed balancer rounds in last 5 attempts'] = report.count;
      if (report.count > 0) {
        balancer['Last reported error'] = report.lastErr;
        balancer['Time of Reported error'] = report.lastTime;
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      let migrations = changelogColl.aggregate([
        { $match: { time: { $gt: yesterday }, what: 'moveChunk.from', 'details.errmsg': { $exists: false }, 'details.note': 'success' } },
        { $group: { _id: { msg: '$details.errmsg' }, count: { $sum: 1 } } },
        { $project: { _id: { $ifNull: ['$_id.msg', 'Success'] }, count: '$count' } },
      ]).toArray();
      migrations = migrations.concat(changelogColl.aggregate([
        { $match: { time: { $gt: yesterday }, what: 'moveChunk.from', $or: [{ 'details.errmsg': { $exists: true } }, { 'details.note': { $ne: 'success' } }] } },
        { $group: { _id: { msg: '$details.errmsg', from: '$details.from', to: '$details.to' }, count: { $sum: 1 } } },
        { $project: { _id: { $ifNull: ['$_id.msg', 'aborted'] }, from: '$_id.from', to: '$_id.to', count: '$count' } },
      ]).toArray());
      const summary = {};
      for (const entry of migrations) {
        summary[entry.count] = entry._id === 'Success' ? entry._id : `Failed with error '${entry._id}', from ${entry.from} to ${entry.to}`;
      }
      balancer['Migration Results for the last 24 hours'] = migrations.length > 0 ? summary : 'No recent migrations';
    }
    result.balancer = balancer;

    const databases = configDB.getCollection('databases').find().sort({ _id: 1 }).toArray();
    // The config database has no entry of its own.
    databases.push({ _id: 'config', primary: 'config', partitioned: true });
    databases.sort((a, b) => a._id.localeCompare(b._id));

    const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result.databases = databases.map((database) => {
      const collections = configDB.getCollection('collections')
        .find(Object.assign({ _id: new RegExp(`^${escapeRegex(database._id)}\\.`) }, SHARDED_ONLY))
        .sort({ _id: 1 })
        .toArray();
      const entries = collections.map((collection) => {
        const info = {};
        info.shardKey = collection.key;
        info.unique = !!collection.unique;
        if (typeof collection.unique !== 'boolean' && collection.unique !== undefined) {
          info.unique = [!!collection.unique, { unique: collection.unique }];
        }
        info.balancing = !collection.noBalance;
        if (typeof collection.noBalance !== 'boolean' && collection.noBalance !== undefined) {
          info.balancing = [!collection.noBalance, { noBalance: collection.noBalance }];
        }
        const match = chunksMatch(collection);
        const perShard = chunksColl.aggregate([
          { $match: match },
          { $group: { _id: '$shard', cnt: { $sum: 1 } } },
          { $project: { _id: 0, shard: '$_id', nChunks: '$cnt' } },
          { $sort: { shard: 1 } },
        ]).toArray();
        let totalChunks = 0;
        info.chunkMetadata = [];
        for (const entry of perShard) {
          totalChunks += entry.nChunks;
          info.chunkMetadata.push({ shard: entry.shard, nChunks: entry.nChunks });
        }
        const chunks = [];
        if (totalChunks < 20 || verbose) {
          for (const chunk of chunksColl.find(match).sort({ min: 1 }).toArray()) {
            const row = { min: chunk.min, max: chunk.max, 'on shard': chunk.shard, 'last modified': chunk.lastmod };
            if (chunk.jumbo) row.jumbo = 'yes';
            // One line per chunk keeps even small collections readable.
            Object.defineProperty(row, msh.symbols.inspectCustom, {
              value(depth, options, inspect) {
                return inspect(Object.assign({}, row), Object.assign({}, options, { breakLength: Infinity }));
              },
              enumerable: false,
            });
            chunks.push(row);
          }
        } else {
          chunks.push('too many chunks to print, use verbose if you want to force print');
        }
        info.chunks = chunks;
        info.tags = configDB.getCollection('tags').find(match.uuid !== undefined ? { ns: collection._id } : match).sort({ min: 1 }).toArray()
          .map((tag) => ({ tag: tag.tag, min: tag.min, max: tag.max }));
        return [collection._id, info];
      });
      return { database, collections: Object.fromEntries(entries) };
    });

    delete result.shardingVersion.currentVersion;
    return result;
  };

  /** Sharding helpers only make sense through a mongos; say so otherwise. */
  msh.warnIfNotMongos = function (mongo) {
    let isMongos = false;
    try {
      isMongos = mongo._hello().msg === 'isdbgrid';
    } catch { /* the command that follows reports the real problem */ }
    if (!isMongos) {
      msh.println('Warning: MongoshWarning: [SHAPI-10003] You are not connected to a mongos. This command may not work as expected.');
    }
  };

  class Shard {
    constructor(database) {
      msh.hide(this, { _database: database });
    }

    [asPrintable]() {
      return `Shard class connected to ${this._database._mongo._redactedUri} via db ${this._database._name}`;
    }

    _admin(cmd) {
      return this._database._mongo._run('admin', cmd, {});
    }

    /** The config database, with a warning when this is not a mongos. */
    _config() {
      msh.warnIfNotMongos(this._database._mongo);
      return this._database.getSiblingDB('config');
    }

    _setting(id, update) {
      return this._config().getCollection('settings').updateOne({ _id: id }, update, { upsert: true, writeConcern: MAJORITY(30000) });
    }

    status(verbose, configDB) {
      const result = msh.getPrintableShardStatus(configDB || this._config(), !!verbose);
      return new msh.CommandResult('StatsResult', result);
    }

    addShard(url, name) {
      msh.required([url], 1, 'Shard.addShard');
      this._config();
      return this._admin(msh.compact({ addShard: url, name }));
    }

    listShards() {
      this._config();
      return this._admin({ listShards: 1 }).shards;
    }

    addShardToZone(shard, zone) {
      msh.required([shard, zone], 2, 'Shard.addShardToZone');
      this._config();
      return this._admin({ addShardToZone: shard, zone });
    }

    addShardTag(shard, tag) {
      msh.required([shard, tag], 2, 'Shard.addShardTag');
      try {
        return this.addShardToZone(shard, tag);
      } catch (error) {
        if (error && error.codeName === 'CommandNotFound') {
          throw new MongoshInvalidInputError(`${error.message}. This method aliases to addShardToZone which exists only for server versions > 3.4.`, 'SHAPI-10006');
        }
        throw error;
      }
    }

    removeShardFromZone(shard, zone) {
      msh.required([shard, zone], 2, 'Shard.removeShardFromZone');
      this._config();
      return this._admin({ removeShardFromZone: shard, zone });
    }

    removeShardTag(shard, tag) {
      msh.required([shard, tag], 2, 'Shard.removeShardTag');
      try {
        return this.removeShardFromZone(shard, tag);
      } catch (error) {
        if (error && error.codeName === 'CommandNotFound') {
          throw new MongoshInvalidInputError(`${error.message}. This method aliases to removeShardFromZone which exists only for server versions > 3.4.`, 'SHAPI-10006');
        }
        throw error;
      }
    }

    updateZoneKeyRange(namespace, min, max, zone) {
      msh.required([namespace, min, max, zone], 4, 'Shard.updateZoneKeyRange');
      this._config();
      return this._admin({ updateZoneKeyRange: namespace, min, max, zone });
    }

    addTagRange(namespace, min, max, zone) {
      msh.required([namespace, min, max, zone], 4, 'Shard.addTagRange');
      try {
        return this.updateZoneKeyRange(namespace, min, max, zone);
      } catch (error) {
        if (error && error.codeName === 'CommandNotFound') {
          throw new MongoshInvalidInputError(`${error.message}. This method aliases to updateZoneKeyRange which exists only for server versions > 3.4.`, 'SHAPI-10006');
        }
        throw error;
      }
    }

    removeRangeFromZone(ns, min, max) {
      msh.required([ns, min, max], 3, 'Shard.removeRangeFromZone');
      this._config();
      return this._admin({ updateZoneKeyRange: ns, min, max, zone: null });
    }

    removeTagRange(ns, min, max) {
      msh.required([ns, min, max], 3, 'Shard.removeTagRange');
      try {
        return this.removeRangeFromZone(ns, min, max);
      } catch (error) {
        if (error && error.codeName === 'CommandNotFound') {
          throw new MongoshInvalidInputError(`${error.message}. This method aliases to updateZoneKeyRange which exists only for server versions > 3.4.`, 'SHAPI-10006');
        }
        throw error;
      }
    }

    enableSharding(database, primaryShard) {
      msh.required([database], 1, 'Shard.enableSharding');
      this._config();
      return this._admin(msh.compact({ enableSharding: database, primaryShard }));
    }

    shardCollection(namespace, key, unique, options) {
      msh.required([namespace, key], 2, 'Shard.shardCollection');
      this._config();
      if (typeof unique === 'object' && unique !== null) {
        options = unique;
        unique = undefined;
      }
      const cmd = { shardCollection: namespace, key };
      if (unique !== undefined) cmd.unique = unique;
      return this._admin(Object.assign(cmd, options));
    }

    reshardCollection(namespace, key, unique, options) {
      msh.required([namespace, key], 2, 'Shard.reshardCollection');
      this._config();
      if (typeof unique === 'object' && unique !== null) {
        options = unique;
        unique = undefined;
      }
      const cmd = { reshardCollection: namespace, key };
      if (unique !== undefined) cmd.unique = unique;
      return this._admin(Object.assign(cmd, options));
    }

    commitReshardCollection(namespace) {
      msh.required([namespace], 1, 'Shard.commitReshardCollection');
      this._config();
      return this._admin({ commitReshardCollection: namespace });
    }

    abortReshardCollection(namespace) {
      msh.required([namespace], 1, 'Shard.abortReshardCollection');
      this._config();
      return this._admin({ abortReshardCollection: namespace });
    }

    shardAndDistributeCollection(ns, key, unique, options) {
      this.shardCollection(ns, key, unique, options);
      if (typeof unique === 'object' && unique !== null) {
        options = unique;
        unique = undefined;
      }
      const reshardOptions = Object.assign({}, options, { forceRedistribution: true });
      delete reshardOptions.presplitHashedZones;
      return this.reshardCollection(ns, key, unique, reshardOptions);
    }

    moveCollection(ns, toShard) {
      msh.required([ns, toShard], 2, 'Shard.moveCollection');
      this._config();
      return this._admin({ moveCollection: ns, toShard });
    }

    abortMoveCollection(ns) {
      msh.required([ns], 1, 'Shard.abortMoveCollection');
      this._config();
      return this._admin({ abortMoveCollection: ns });
    }

    unshardCollection(ns, toShard) {
      msh.required([ns], 1, 'Shard.unshardCollection');
      this._config();
      return this._admin(msh.compact({ unshardCollection: ns, toShard }));
    }

    abortUnshardCollection(ns) {
      msh.required([ns], 1, 'Shard.abortUnshardCollection');
      this._config();
      return this._admin({ abortUnshardCollection: ns });
    }

    enableAutoSplit() {
      return this._setting('autosplit', { $set: { enabled: true } });
    }

    disableAutoSplit() {
      return this._setting('autosplit', { $set: { enabled: false } });
    }

    splitAt(ns, query) {
      msh.required([ns, query], 2, 'Shard.splitAt');
      this._config();
      return this._admin({ split: ns, middle: query });
    }

    splitFind(ns, query) {
      msh.required([ns, query], 2, 'Shard.splitFind');
      this._config();
      return this._admin({ split: ns, find: query });
    }

    moveChunk(ns, query, destination) {
      msh.required([ns, query, destination], 3, 'Shard.moveChunk');
      this._config();
      return this._admin({ moveChunk: ns, find: query, to: destination });
    }

    moveRange(ns, toShard, min, max) {
      msh.required([ns, toShard], 2, 'Shard.moveRange');
      this._config();
      return this._admin(msh.compact({ moveRange: ns, toShard, min, max }));
    }

    balancerCollectionStatus(ns) {
      msh.required([ns], 1, 'Shard.balancerCollectionStatus');
      this._config();
      return this._admin({ balancerCollectionStatus: ns });
    }

    _setBalancing(ns, noBalance) {
      return this._config().getCollection('collections').updateOne({ _id: ns }, { $set: { noBalance } }, { writeConcern: MAJORITY(60000) });
    }

    enableBalancing(ns) {
      msh.required([ns], 1, 'Shard.enableBalancing');
      return this._setBalancing(ns, false);
    }

    disableBalancing(ns) {
      msh.required([ns], 1, 'Shard.disableBalancing');
      return this._setBalancing(ns, true);
    }

    enableMigrations(ns) {
      msh.required([ns], 1, 'Shard.enableMigrations');
      this._config();
      return this._admin({ setAllowMigrations: ns, allowMigrations: true });
    }

    disableMigrations(ns) {
      msh.required([ns], 1, 'Shard.disableMigrations');
      this._config();
      return this._admin({ setAllowMigrations: ns, allowMigrations: false });
    }

    getBalancerState() {
      const doc = this._config().getCollection('settings').findOne({ _id: 'balancer' });
      return doc === null || !doc.stopped;
    }

    isBalancerRunning() {
      this._config();
      return this._admin({ balancerStatus: 1 });
    }

    startBalancer(timeout) {
      this._config();
      return this._admin({ balancerStart: 1, maxTimeMS: timeout === undefined ? 60000 : timeout });
    }

    stopBalancer(timeout) {
      this._config();
      return this._admin({ balancerStop: 1, maxTimeMS: timeout === undefined ? 60000 : timeout });
    }

    setBalancerState(state) {
      msh.required([state], 1, 'Shard.setBalancerState');
      return state ? this.startBalancer() : this.stopBalancer();
    }

    getShardedDataDistribution(options) {
      this._config();
      return this._database.getSiblingDB('admin').aggregate([{ $shardedDataDistribution: options || {} }]);
    }

    startAutoMerger() {
      return this._setting('automerge', { $set: { enabled: true } });
    }

    stopAutoMerger() {
      return this._setting('automerge', { $set: { enabled: false } });
    }

    isAutoMergerEnabled() {
      const doc = this._config().getCollection('settings').findOne({ _id: 'automerge' });
      return doc === null || doc.enabled;
    }

    enableAutoMerger(ns) {
      msh.required([ns], 1, 'Shard.enableAutoMerger');
      return this._config().getCollection('collections').updateOne({ _id: ns }, { $unset: { enableAutoMerge: 1 } }, { writeConcern: MAJORITY(60000) });
    }

    disableAutoMerger(ns) {
      msh.required([ns], 1, 'Shard.disableAutoMerger');
      return this._config().getCollection('collections').updateOne({ _id: ns }, { $set: { enableAutoMerge: false } }, { writeConcern: MAJORITY(60000) });
    }

    checkMetadataConsistency(options) {
      this._config();
      return this._database.getSiblingDB('admin').checkMetadataConsistency(options);
    }

    isConfigShardEnabled() {
      const shards = this.listShards();
      const config = shards.find((shard) => shard._id === 'config');
      if (!config) return { enabled: false };
      return msh.compact({ enabled: true, host: config.host, tags: config.tags });
    }

    getTransitionToDedicatedConfigServerStatus() {
      this._config();
      return this._admin({ getTransitionToDedicatedConfigServerStatus: 1 });
    }

    shardDrainingStatus(shardId) {
      msh.required([shardId], 1, 'Shard.shardDrainingStatus');
      this._config();
      return this._admin({ shardDrainingStatus: shardId });
    }
  }

  msh.describeClass(Shard, {
    type: 'Shard',
    help: 'The Shard Class',
    prefix: 'Shard',
    docs: `${msh.docs.manual}/js-sharding`,
    methods: {
      enableSharding: 'Creates a database in the cluster, optionally on a chosen primary shard.',
      commitReshardCollection: 'Forces a resharding operation to finish its commit phase.',
      abortReshardCollection: 'Aborts a resharding operation in progress.',
      shardCollection: 'Shards a collection on the given shard key.',
      reshardCollection: 'Changes the shard key of a sharded collection.',
      status: 'Prints the sharding configuration, balancer state and chunk distribution. Pass true for more detail.',
      addShard: 'Adds a shard (replica set connection string) to the cluster.',
      addShardToZone: 'Assigns a shard to a zone.',
      addShardTag: 'Alias of addShardToZone.',
      updateZoneKeyRange: 'Assigns a range of shard key values to a zone.',
      addTagRange: 'Alias of updateZoneKeyRange.',
      removeRangeFromZone: 'Removes the zone assignment of a range of shard key values.',
      removeTagRange: 'Alias of removeRangeFromZone.',
      removeShardFromZone: 'Removes a shard from a zone.',
      removeShardTag: 'Alias of removeShardFromZone.',
      enableAutoSplit: 'Enables automatic chunk splitting (servers before 6.0.3).',
      disableAutoSplit: 'Disables automatic chunk splitting (servers before 6.0.3).',
      splitAt: 'Splits a chunk at the given shard key value.',
      splitFind: 'Splits the chunk containing the matching document at its median.',
      moveChunk: 'Moves the chunk containing the matching document to another shard.',
      moveRange: 'Moves a range of shard key values to another shard.',
      balancerCollectionStatus: 'Reports whether the chunks of a collection are balanced.',
      enableBalancing: 'Lets the balancer move chunks of a collection.',
      disableBalancing: 'Stops the balancer from moving chunks of a collection.',
      getBalancerState: 'Returns true when the balancer is enabled.',
      isBalancerRunning: 'Returns the balancer status, including whether a round is in progress.',
      startBalancer: 'Enables the balancer.',
      stopBalancer: 'Disables the balancer and waits for the current round to end.',
      setBalancerState: 'Enables or disables the balancer.',
      getShardedDataDistribution: 'Returns a cursor over the data distribution of sharded collections.',
      startAutoMerger: 'Enables automatic merging of chunks.',
      stopAutoMerger: 'Disables automatic merging of chunks.',
      isAutoMergerEnabled: 'Returns whether automatic chunk merging is enabled.',
      disableAutoMerger: 'Disables automatic chunk merging for one collection.',
      enableAutoMerger: 'Re-enables automatic chunk merging for one collection.',
      checkMetadataConsistency: 'Returns a cursor over sharding metadata inconsistencies in the cluster.',
      shardAndDistributeCollection: 'Shards a collection and immediately redistributes its data.',
      moveCollection: 'Moves an unsharded collection to another shard.',
      abortMoveCollection: 'Aborts a moveCollection operation in progress.',
      unshardCollection: 'Turns a sharded collection back into an unsharded one.',
      abortUnshardCollection: 'Aborts an unshardCollection operation in progress.',
      listShards: 'Returns the shards of the cluster.',
      isConfigShardEnabled: 'Reports whether the config server also acts as a shard.',
      enableMigrations: 'Allows chunk migrations for a collection.',
      disableMigrations: 'Blocks chunk migrations for a collection.',
      getTransitionToDedicatedConfigServerStatus: 'Reports progress of moving data off a config shard.',
      shardDrainingStatus: 'Reports progress of draining a shard that is being removed.',
    },
  });

  msh.Shard = Shard;
})(globalThis);
