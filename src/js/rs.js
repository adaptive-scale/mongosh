// The `rs` object: replica set administration helpers.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const { asPrintable } = msh.symbols;
  const { MongoshInvalidInputError, MongoshRuntimeError, MongoshDeprecatedError } = msh.errors;

  class ReplicaSet {
    constructor(database) {
      msh.hide(this, { _database: database });
    }

    [asPrintable]() {
      return `ReplicaSet class connected to ${this._database._mongo._redactedUri} via db ${this._database._name}`;
    }

    _admin(cmd) {
      return this._database._mongo._run('admin', cmd, {});
    }

    _getConfig() {
      try {
        const reply = this._admin({ replSetGetConfig: 1 });
        if (reply.config === undefined) throw new MongoshRuntimeError('Documented returned from command replSetGetConfig does not contain \'config\'', 'COMMON-10004');
        return reply.config;
      } catch (error) {
        if (error && (error.codeName === 'CommandNotFound' || /no such cmd/.test(error.message || ''))) {
          const doc = this._database.getSiblingDB('local').getCollection('system.replset').findOne();
          if (doc === null) throw new MongoshRuntimeError('No documents in local.system.replset', 'COMMON-10004');
          return doc;
        }
        throw error;
      }
    }

    initiate(config) {
      return this._admin({ replSetInitiate: config === undefined ? {} : config });
    }

    config() {
      return this._getConfig();
    }

    conf() {
      return this._getConfig();
    }

    reconfig(config, options) {
      msh.required([config], 1, 'ReplicaSet.reconfig');
      const current = this._getConfig();
      config.version = current.version ? current.version + 1 : 1;
      if (config.protocolVersion === undefined) config.protocolVersion = current.protocolVersion;
      return this._admin(Object.assign({ replSetReconfig: config }, options));
    }

    /**
     * Add a voting data member to a primary-secondary-arbiter set safely:
     * first with priority 0 and one vote, then with its real priority.
     */
    reconfigForPSASet(newMemberIndex, config, options) {
      msh.required([newMemberIndex, config], 2, 'ReplicaSet.reconfigForPSASet');
      const newMember = config.members && config.members[newMemberIndex];
      if (!newMember) throw msh.invalidInput(`Node at index ${newMemberIndex} does not exist in the new config`);
      if (newMember.votes !== 1) throw msh.invalidInput(`Node at index ${newMemberIndex} must have { votes: 1 } in the new config (actual: { votes: ${newMember.votes} })`);
      const current = this._getConfig();
      const old = current.members.find((member) => member._id === newMember._id);
      if (!old) throw msh.invalidInput(`Node with _id ${newMember._id} does not exist in the old config`);
      if (old.votes === 1) throw msh.invalidInput(`Node with _id ${newMember._id} must have { votes: 0 } in the old config (actual: { votes: ${old.votes} })`);
      const priority = newMember.priority;
      newMember.priority = 0;
      msh.println(`Running first reconfig to give member at index ${newMemberIndex} { votes: 1, priority: 0 }`);
      this.reconfig(config, options);
      msh.println(`Running second reconfig to give member at index ${newMemberIndex} { priority: ${priority} }`);
      newMember.priority = priority;
      for (let attempt = 1; ; attempt++) {
        try {
          return this.reconfig(config, options);
        } catch (error) {
          if (attempt >= 12) throw error;
          msh.println(`Reconfig did not succeed yet, starting new attempt...`);
          msh.native.sleep(1000 * Math.min(attempt, 5));
        }
      }
    }

    status() {
      return this._admin({ replSetGetStatus: 1 });
    }

    isMaster() {
      return this._database.getSiblingDB('admin').isMaster();
    }

    hello() {
      return this._database.getSiblingDB('admin').hello();
    }

    printSecondaryReplicationInfo() {
      return this._database.printSecondaryReplicationInfo();
    }

    printSlaveReplicationInfo() {
      throw new MongoshDeprecatedError('printSlaveReplicationInfo has been deprecated. Use printSecondaryReplicationInfo instead', 'COMMON-10003');
    }

    printReplicationInfo() {
      return this._database.printReplicationInfo();
    }

    add(hostport, arb) {
      msh.required([hostport], 1, 'ReplicaSet.add');
      const config = this._getConfig();
      config.version++;
      const max = Math.max(...config.members.map((member) => member._id));
      let member;
      if (typeof hostport === 'string') {
        member = { _id: max + 1, host: hostport };
        if (arb) member.arbiterOnly = true;
      } else if (arb === true) {
        throw new MongoshInvalidInputError(`Expected first parameter to be a host-and-port string of arbiter, but got ${JSON.stringify(hostport)}`, 'COMMON-10001');
      } else {
        member = hostport;
        if (member._id === null || member._id === undefined) member._id = max + 1;
      }
      config.members.push(member);
      return this._admin({ replSetReconfig: config });
    }

    addArb(hostname) {
      return this.add(hostname, true);
    }

    remove(hostname) {
      msh.required([hostname], 1, 'ReplicaSet.remove');
      if (typeof hostname !== 'string') throw msh.invalidInput(`Argument at position 0 must be of type string, got ${typeof hostname} instead (ReplicaSet.remove)`);
      const config = this._getConfig();
      config.version++;
      for (let i = 0; i < config.members.length; i++) {
        if (config.members[i].host === hostname) {
          config.members.splice(i, 1);
          return this._admin({ replSetReconfig: config });
        }
      }
      throw new MongoshInvalidInputError(`Couldn't find ${hostname} in ${JSON.stringify(config.members)}. Is ${hostname} a member of this replset?`, 'COMMON-10001');
    }

    freeze(secs) {
      msh.required([secs], 1, 'ReplicaSet.freeze');
      return this._admin({ replSetFreeze: secs });
    }

    stepDown(stepdownSecs, catchUpSecs) {
      const cmd = { replSetStepDown: stepdownSecs === undefined ? 60 : stepdownSecs };
      if (catchUpSecs !== undefined) cmd.secondaryCatchUpPeriodSecs = catchUpSecs;
      return this._admin(cmd);
    }

    syncFrom(host) {
      msh.required([host], 1, 'ReplicaSet.syncFrom');
      return this._admin({ replSetSyncFrom: host });
    }

    secondaryOk() {
      msh.deprecated('.setSecondaryOk() is deprecated. Use .setReadPref("primaryPreferred") instead');
      this._database._mongo.setSecondaryOk();
    }
  }

  msh.describeClass(ReplicaSet, {
    type: 'ReplicaSet',
    help: 'Replica Set Class',
    prefix: 'ReplicaSet',
    docs: `${msh.docs.manual}/js-replication`,
    methods: {
      initiate: 'Initiates a replica set, optionally with an explicit configuration.',
      config: 'Returns the current replica set configuration.',
      conf: 'Alias of config.',
      reconfig: 'Applies a new replica set configuration, incrementing its version.',
      reconfigForPSASet: 'Reconfigures a primary-secondary-arbiter set in two safe steps.',
      status: 'Returns the status of every member as seen by this server.',
      isMaster: 'Legacy form of hello().',
      hello: 'Returns the role of this server in the replica set.',
      printSecondaryReplicationInfo: 'Prints how far each secondary lags behind the primary.',
      printSlaveReplicationInfo: 'Removed. Use printSecondaryReplicationInfo().',
      printReplicationInfo: 'Prints the size and time range of the oplog.',
      add: 'Adds a member, given a host string or a member document.',
      addArb: 'Adds an arbiter.',
      remove: 'Removes the member with the given host.',
      freeze: 'Prevents this member from seeking election for the given number of seconds.',
      stepDown: 'Makes the primary step down and become a secondary.',
      syncFrom: 'Changes the member this server replicates from.',
      secondaryOk: 'Deprecated. Sets the read preference to primaryPreferred.',
    },
  });

  msh.ReplicaSet = ReplicaSet;
})(globalThis);
