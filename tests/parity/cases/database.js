db = db.getSiblingDB('__DB__'); [db.getName(), db.getMongo() === db.getSiblingDB('x').getMongo(), db.getSiblingDB('other').getName(), typeof db.version(), db.version() === db.serverBuildInfo().version, db.serverBits(), typeof db.hostInfo().system, db.hello().isWritablePrimary, db.isMaster().ismaster, typeof db.serverStatus().uptime, db.serverStatus({repl: 0, metrics: 0}).ok, Object.keys(db.serverCmdLineOpts()).includes('parsed')]
###
db = db.getSiblingDB('__DB__'); db.createCollection('a'); db.createCollection('cap', {capped: true, size: 1024}); db.createView('v', 'a', [{$match: {x: 1}}]); db.createCollection('ts', {timeseries: {timeField: 't'}}); [db.getCollectionNames().sort(), db.getCollectionInfos().map(i => [i.name, i.type]).sort(), db.getCollectionInfos({name: 'cap'})[0].options, db.getCollectionInfos({type: 'view'}).map(i => i.name), db.getCollectionInfos({}, {nameOnly: true}).length]
###
db = db.getSiblingDB('__DB__'); db.createCollection('b'); db.createCollection('a'); db.createCollection('Zed'); db.createView('vw', 'a', []); db.createCollection('ts', {timeseries: {timeField: 't'}}); show('collections')
###
db = db.getSiblingDB('__DB__'); show('collections')
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); var s = db.stats(); [s.db, s.collections, s.views, s.objects, s.indexes, s.scaleFactor, s.ok, db.stats(1024).scaleFactor, db.stats({scale: 2, freeStorage: 1}).scaleFactor, Object.keys(db.stats()).filter(k => !k.startsWith('$') && k !== 'operationTime')]
###
db = db.getSiblingDB('__DB__'); [db.runCommand('ping').ok, db.runCommand({ping: 1}).ok, db.adminCommand('ping').ok, db.adminCommand({listDatabases: 1, nameOnly: true}).ok, db.runCommand({buildInfo: 1}).version === db.version(), db.commandHelp('ping'), typeof db.listCommands, db.runCommand({count: 'nope'}).n]
###
db.runCommand()
###
db.adminCommand()
###
db.runCommand({find: 'c', filter: {$bad: 1}})
###
db = db.getSiblingDB('__DB__'); db.aggregate([{$documents: [{a: 1}, {a: 2}]}, {$match: {a: 2}}]).toArray()
###
db = db.getSiblingDB('__DB__'); db.aggregate([{$documents: [{a: 1}, {a: 2}]}])
###
db = db.getSiblingDB('__DB__'); [db.createUser({user: 'u1', pwd: 'p1', roles: ['read']}), db.createUser({user: 'u2', pwd: 'p2', roles: [{role: 'readWrite', db: '__DB__'}], customData: {x: 1}}), db.getUser('u1').roles, db.getUser('u2').customData, db.getUser('nope'), db.getUsers().users.map(u => u.user).sort(), db.updateUser('u1', {roles: ['readWrite'], customData: {y: 2}}), db.getUser('u1').roles, db.changeUserPassword('u1', 'newpw'), db.grantRolesToUser('u1', ['dbAdmin']), db.getUser('u1').roles.map(r => r.role).sort(), db.revokeRolesFromUser('u1', ['dbAdmin']), db.getUser('u1').roles.map(r => r.role), db.dropUser('u2'), db.dropAllUsers(), db.getUsers().users]
###
db = db.getSiblingDB('__DB__'); db.createUser({user: 'u1', pwd: 'p1', roles: ['read']}); db.getUser('u1')
###
db = db.getSiblingDB('__DB__'); db.createUser({user: 'u1', pwd: 'p1', roles: ['read']}); db.getUsers()
###
db = db.getSiblingDB('__DB__'); db.dropUser('nope')
###
db.createUser({user: 'x'})
###
db.createUser({user: 'x', roles: []})
###
db.createUser({pwd: 'x', roles: []})
###
db.createUser()
###
db = db.getSiblingDB('__DB__'); db.createUser({user: 'su', pwd: 'p', roles: []}); db.createUser({user: 'su', pwd: 'p', roles: []})
###
db = db.getSiblingDB('__DB__'); db.createUser({user: 'su', pwd: 'p', roles: []}); show('users')
###
db = db.getSiblingDB('__DB__'); [db.createRole({role: 'r1', privileges: [], roles: []}), db.createRole({role: 'r2', privileges: [{resource: {db: '__DB__', collection: 'c'}, actions: ['find']}], roles: ['r1']}), db.getRole('r1'), db.getRole('r2', {showPrivileges: true}).privileges, db.getRole('nope'), db.getRoles().roles.map(r => r.role).sort(), db.getRoles({showBuiltinRoles: true}).roles.length > 5, db.updateRole('r1', {roles: ['read']}), db.getRole('r1').roles, db.grantRolesToRole('r1', ['readWrite']), db.revokeRolesFromRole('r1', ['read']), db.getRole('r1').roles.map(r => r.role), db.grantPrivilegesToRole('r1', [{resource: {db: '__DB__', collection: ''}, actions: ['insert']}]), db.revokePrivilegesFromRole('r1', [{resource: {db: '__DB__', collection: ''}, actions: ['insert']}]), db.dropRole('r2'), db.dropAllRoles(), db.getRoles().roles]
###
db.createRole({role: 'x'})
###
db = db.getSiblingDB('__DB__'); db.createCollection('c'); var before = db.getProfilingStatus(); var r = db.setProfilingLevel(1, 50); var r2 = db.setProfilingLevel(2, {slowms: 20, sampleRate: 0.5}); var st = db.getProfilingStatus(); db.setProfilingLevel(0); [before.was, r.was, r.ok, r2.was, r2.slowms, st.was, st.slowms, st.sampleRate]
###
db.setProfilingLevel(5)
###
db.setProfilingLevel()
###
db.setLogLevel(1, 5)
###
[Object.keys(db.currentOp()), db.currentOp().ok, Array.isArray(db.currentOp(true).inprog), db.currentOp({$all: true, active: true}).ok, db.killOp(123456789).ok]
###
db.killOp()
###
[db.getMongo().getDBNames().includes('admin'), db.getMongo().getDBs().ok, typeof db.getMongo().getDBs().totalSize, db.getMongo().getDB('x').getName(), db.getMongo().getCollection('a.b.c').getFullName(), db.getMongo().getReadPrefMode(), db.getMongo().getReadConcern(), db.getMongo().getWriteConcern(), typeof db.getMongo().getURI()]
###
db.getMongo().getReadPref()
###
var m = db.getMongo(); m.setReadPref('secondaryPreferred', [{dc: 'a'}]); var a = [m.getReadPrefMode(), m.getReadPrefTagSet()]; m.setReadPref('primary'); m.setReadConcern('majority'); m.setWriteConcern('majority', 1000, true); a.concat([m.getReadPrefMode(), m.getReadConcern(), m.getWriteConcern()])
###
db.getMongo().setReadPref('bogus')
###
db.getMongo().getCollection('nodot')
###
db.getMongo().getDB('')
###
db.getMongo().getDB(5)
###
db.getMongo().setCausalConsistency()
###
db.getMongo().isCausalConsistency()
###
new Mongo('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500')
###
var m2 = new Mongo(db.getMongo().getURI()); var d2 = m2.getDB('__DB__'); d2.c.insertOne({_id: 1}); var r = [d2.c.countDocuments(), db.getSiblingDB('__DB__').c.countDocuments(), m2 !== db.getMongo()]; m2.close(); r
###
var m2 = new Mongo(db.getMongo().getURI()); m2.close(); m2.getDB('x').c.findOne()
###
var d3 = connect(db.getMongo().getURI()); [d3.getName(), typeof d3.getMongo]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1, n: 0}); var s = db.getMongo().startSession(); var sdb = s.getDatabase('__DB__'); s.startTransaction(); sdb.c.updateOne({_id: 1}, {$inc: {n: 1}}); sdb.c.insertOne({_id: 2}); var inside = [sdb.c.countDocuments(), db.c.countDocuments(), db.c.findOne({_id: 1}).n]; s.commitTransaction(); var after = [db.c.countDocuments(), db.c.findOne({_id: 1}).n]; s.startTransaction(); sdb.c.deleteMany({}); s.abortTransaction(); var aborted = db.c.countDocuments(); var ended = [s.hasEnded()]; s.endSession(); ended.push(s.hasEnded()); [inside, after, aborted, ended, Object.keys(s.id), s.getOptions()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); var s = db.getMongo().startSession(); var r = s.withTransaction(() => { s.getDatabase('__DB__').c.insertOne({_id: 2}); return 'done' }); var r2; try { s.withTransaction(() => { s.getDatabase('__DB__').c.insertOne({_id: 3}); throw new Error('rollback') }) } catch (e) { r2 = e.message } [r, r2, db.c.find().sort({_id: 1}).toArray()]
###
db = db.getSiblingDB('__DB__'); var s = db.getMongo().startSession({causalConsistency: false}); var r = [s.getOptions(), typeof s.getClusterTime(), typeof s.getOperationTime()]; s.endSession(); r
###
var s = db.getMongo().startSession(); s
###
var s = db.getMongo().startSession(); s.endSession(); s.getDatabase('x').c.findOne()
###
var s = db.getMongo().startSession(); s.commitTransaction()
###
var s = db.getMongo().startSession(); s.abortTransaction()
###
var s = db.getMongo().startSession(); s.startTransaction(); s.startTransaction()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); var s = db.getMongo().startSession(); var c = s.getDatabase('__DB__').c; s.startTransaction({readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}}); c.insertOne({_id: 2}); var seen = c.find().sort({_id: 1}).toArray(); var agg = c.aggregate([{$count: 'n'}]).toArray(); s.commitTransaction(); [seen, agg, db.c.countDocuments()]
###
[rs.status().set, rs.status().members.length, rs.status().members[0].stateStr, rs.conf()._id, rs.config().members[0].host, rs.conf().members.length, rs.hello().setName, rs.hello().isWritablePrimary, rs.isMaster().ismaster, typeof rs.conf().version]
###
print(rs); print(sh); print(db.getMongo())
###
rs.remove('nohost:1')
###
rs.add({host: 'x'}, true)
###
rs.remove()
###
rs.printSlaveReplicationInfo()
###
Object.keys(db.getReplicationInfo())
###
rs.syncFrom('nohost:27017')
###
sh.status()
###
sh.getBalancerState()
###
sh.addShard('x/y:1')
###
db.printShardingStatus()
###
db.cloneDatabase('x')
###
db.copyDatabase('a', 'b')
###
var t = Date.now(); sleep(150); Date.now() - t >= 140
###
[typeof help, typeof help(), typeof db.help, typeof db.help(), typeof db.c.help(), typeof db.c.find.help, typeof rs.help(), typeof sh.help(), typeof db.getMongo().help(), typeof db.c.find().help()]
###
db = 5
###
db = db.getSiblingDB('__DB__'); db.getName()
###
use('__DB__'); db.getName()
###
show('dbs').constructor === undefined
###
typeof show('logs')
###
show('nope')
