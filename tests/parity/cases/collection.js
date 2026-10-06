db = db.getSiblingDB('__DB__'); [db.c.getName(), db.c.getFullName(), db.c.getDB().getName(), db.c.getMongo() === db.getMongo(), db.getCollection('a.b').getFullName(), db.a.b.getName(), db.a.b.c.getFullName(), typeof db.c.nope, db.c.toString(), String(db), db.getCollection('with space').getName(), db['dash-name'].getName()]
###
db.c.nope()
###
db.getCollection('')
###
db.getCollection('a$b')
###
db.getCollection(5)
###
db.getSiblingDB('')
###
db.getSiblingDB('a.b')
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1, t: 'x'}, {_id: 2, a: 2, t: 'y'}, {_id: 3, a: 3, t: 'x'}]); [db.c.findOne({a: 2}), db.c.findOne({a: 2}, {t: 1}), db.c.findOne({a: 2}, {_id: 0, t: 1}), db.c.findOne({a: 9}), db.c.findOne({}, null, {sort: {_id: -1}}), db.c.find({}, {a: 1}, {sort: {a: -1}, limit: 1}).toArray(), db.c.find({t: 'x'}).toArray().length, db.c.findOne()._id]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1, t: 'x'}, {_id: 2, a: 2, t: 'y'}, {_id: 3, a: 3, t: 'x'}]); [db.c.countDocuments(), db.c.countDocuments({t: 'x'}), db.c.countDocuments({}, {limit: 2}), db.c.countDocuments({}, {skip: 1}), db.c.countDocuments({t: 'none'}), db.c.estimatedDocumentCount(), db.c.distinct('t'), db.c.distinct('a', {t: 'x'}), db.c.distinct('missing'), db.nothere.countDocuments(), db.nothere.estimatedDocumentCount(), db.nothere.distinct('x')]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}, {_id: 3, a: 3}]); [db.c.updateOne({a: 1}, {$set: {b: 1}}), db.c.updateOne({a: 1}, {$set: {b: 1}}), db.c.updateOne({a: 99}, {$set: {b: 1}}), db.c.updateMany({a: {$gt: 1}}, {$inc: {a: 10}}), db.c.updateOne({_id: 'new'}, {$set: {a: 0}}, {upsert: true}), db.c.updateMany({nope: 1}, {$set: {z: 1}}, {upsert: true}).upsertedCount, db.c.updateOne({a: 1}, [{$set: {c: {$add: ['$a', 5]}}}]), db.c.replaceOne({_id: 2}, {r: true}), db.c.replaceOne({_id: 77}, {r: true}, {upsert: true}), db.c.updateOne({_id: 3}, {$set: {'arr.$[e]': 1}}, {arrayFilters: [{e: 1}]}), db.c.find({_id: {$in: [1, 2, 3]}}).sort({_id: 1}).toArray()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}, {_id: 3, a: 3}, {_id: 4, a: 4}]); [db.c.deleteOne({a: 1}), db.c.deleteOne({a: 1}), db.c.deleteMany({a: {$gt: 2}}), db.c.deleteMany({}), db.c.deleteMany({}), db.c.countDocuments()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1, v: 0}, {_id: 2, a: 1, v: 0}]); [db.c.findOneAndUpdate({a: 1}, {$inc: {v: 1}}, {sort: {_id: -1}}), db.c.findOneAndUpdate({a: 1}, {$inc: {v: 1}}, {sort: {_id: -1}, returnDocument: 'after', projection: {v: 1, _id: 0}}), db.c.findOneAndUpdate({_id: 9}, {$set: {v: 1}}, {upsert: true}), db.c.findOneAndUpdate({_id: 10}, {$set: {v: 1}}, {upsert: true, returnNewDocument: true}), db.c.findOneAndReplace({_id: 1}, {rep: 1}), db.c.findOneAndReplace({_id: 1}, {rep: 2}, {returnDocument: 'after'}), db.c.findOneAndDelete({_id: 2}), db.c.findOneAndDelete({_id: 2}), db.c.findOneAndDelete({}, {sort: {_id: -1}, projection: {_id: 1}}), db.c.findOneAndUpdate({_id: 1}, {$set: {z: 1}}, {includeResultMetadata: true}).lastErrorObject]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1, v: 0}, {_id: 2, a: 1, v: 0}]); [db.c.findAndModify({query: {_id: 1}, update: {$inc: {v: 5}}}), db.c.findAndModify({query: {_id: 1}, update: {$inc: {v: 5}}, new: true}), db.c.findAndModify({query: {_id: 1}, update: {replaced: true}, new: true}), db.c.findAndModify({query: {_id: 2}, remove: true}), db.c.findAndModify({query: {_id: 5}, update: {$set: {u: 1}}, upsert: true, new: true, fields: {u: 1}}), db.c.findAndModify({query: {}, sort: {_id: -1}, update: {$set: {last: true}}, new: true})]
###
db.c.findAndModify({query: {}})
###
db.c.findAndModify({update: {$set: {a: 1}}})
###
db.c.findOneAndUpdate({}, {a: 1})
###
db.c.findOneAndReplace({}, {$set: {a: 1}})
###
db.c.replaceOne({}, {$set: {a: 1}})
###
db.c.findOneAndUpdate({}, {$set: {a: 1}}, {returnDocument: 'sideways'})
###
db.c.insertMany({a: 1})
###
db.c.bulkWrite({})
###
db.c.bulkWrite([{frobnicate: {}}])
###
db.c.updateMany({}, {a: 1})
###
db.c.deleteOne()
###
db.c.distinct()
###
db.c.createIndex()
###
db.c.dropIndex('*')
###
db.c.createIndex({a: 1}, 'notanobject')
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); db.c.dropIndex('nope')
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); db.c.dropIndexes('nope')
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1, a: 1, b: 1, c: 'x', loc: [0, 0]}); [db.c.createIndex({a: 1}), db.c.createIndex({a: 1}), db.c.createIndex({b: -1, a: 1}, {name: 'custom', unique: true, sparse: true}), db.c.createIndex({c: 'text'}), db.c.createIndex({loc: '2d'}), db.c.createIndex({h: 'hashed'}), db.c.createIndex({ttl: 1}, {expireAfterSeconds: 3600}), db.c.createIndex({p: 1}, {partialFilterExpression: {p: {$gt: 5}}}), db.c.createIndex({'w.$**': 1}), db.c.createIndexes([{x: 1}, {y: 1, z: -1}]), db.c.createIndexes([{q: 1}], {hidden: true}), db.c.ensureIndex({e: 1}), db.c.getIndexes().map(i => i.name).sort(), db.c.getIndexKeys().length, db.c.getIndexSpecs().length, db.c.getIndices().length, typeof db.c.totalIndexSize()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1, a: 1, b: 1}); db.c.createIndex({a: 1}); db.c.createIndex({b: 1}, {unique: true, sparse: true, name: 'bidx'}); db.c.createIndex({a: 1, b: -1}, {hidden: true}); db.c.getIndexes()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1, a: 1, b: 1}); db.c.createIndexes([{a: 1}, {b: 1}, {c: 1}, {d: 1}]); [db.c.hideIndex('a_1').ok, db.c.getIndexes().find(i => i.name === 'a_1').hidden, db.c.unhideIndex({a: 1}).ok, db.c.dropIndex({b: 1}).nIndexesWas, db.c.dropIndex('c_1').ok, db.c.dropIndexes(['a_1']).ok, db.c.getIndexes().length, db.c.dropIndexes().nIndexesWas, db.c.getIndexes().length, db.nothere.getIndexes()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1}, {_id: 2}]); db.c.insertOne({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.createIndex({u: 1}, {unique: true}); db.c.insertOne({_id: 1, u: 1}); db.c.updateOne({_id: 2}, {$set: {u: 1}}, {upsert: true})
###
db = db.getSiblingDB('__DB__'); try { db.c.insertMany([{_id: 1}, {_id: 1}, {_id: 2}]) } catch (e) { [e.name, e.message, e.code, e.writeErrors.length, e.writeErrors[0].code, e.writeErrors[0].index, e.writeErrors[0].errmsg, e.result.insertedCount, e.result.insertedIds, e.insertedCount, Object.keys(e), db.c.countDocuments()] }
###
db = db.getSiblingDB('__DB__'); try { db.c.insertMany([{_id: 1}, {_id: 1}, {_id: 2}, {_id: 2}, {_id: 3}], {ordered: false}) } catch (e) { [e.name, e.message, e.code, e.writeErrors.map(w => [w.index, w.code]), e.result.insertedCount, e.result.insertedIds, db.c.countDocuments()] }
###
db = db.getSiblingDB('__DB__'); try { db.c.insertOne({_id: 1}); db.c.insertOne({_id: 1}) } catch (e) { [e.name, e.message, e.code, e.codeName, e.index, e.keyPattern, e.keyValue, e.errmsg, Object.keys(e).sort(), e.errorLabels, typeof e.hasErrorLabel] }
###
try { db.runCommand({nope: 1}) } catch (e) { [e.name, e.message, e.code, e.codeName, e.ok, e.errmsg, Object.keys(e).filter(k => !k.startsWith('$') && k !== 'operationTime').sort(), e.errorLabels] }
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); [db.c.bulkWrite([{insertOne: {document: {_id: 3, a: 3}}}, {insertOne: {_id: 4}}, {updateOne: {filter: {a: 1}, update: {$set: {b: 1}}}}, {updateMany: {filter: {}, update: {$inc: {a: 1}}}}, {replaceOne: {filter: {_id: 2}, replacement: {r: 1}}}, {deleteOne: {filter: {_id: 3}}}, {deleteMany: {filter: {a: {$exists: true}}}}, {updateOne: {filter: {_id: 'u'}, update: {$set: {x: 1}}, upsert: true}}, {replaceOne: {filter: {_id: 'r'}, replacement: {y: 1}, upsert: true}}]), db.c.find().sort({_id: 1}).toArray(), db.c.bulkWrite([{insertOne: {document: {_id: 100}}}, {insertOne: {document: {_id: 101}}}], {ordered: false}), db.c.bulkWrite([{updateOne: {filter: {arr: {$exists: false}, _id: 100}, update: {$set: {'arr.$[i]': 1}}, arrayFilters: [{i: 1}]}}])]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); try { db.c.bulkWrite([{insertOne: {document: {_id: 5}}}, {insertOne: {document: {_id: 1}}}, {insertOne: {document: {_id: 6}}}]) } catch (e) { [e.name, e.message, e.writeErrors.length, e.writeErrors[0].index, e.result.insertedCount, e.result.insertedIds, db.c.countDocuments()] }
###
db = db.getSiblingDB('__DB__'); var b = db.c.initializeOrderedBulkOp(); b.insert({_id: 1, a: 1}); b.insert({_id: 2, a: 2}); b.find({_id: 1}).updateOne({$set: {b: 1}}); b.find({a: {$gt: 0}}).update({$inc: {a: 1}}); b.find({_id: 2}).replaceOne({r: 1}); b.find({_id: 9}).upsert().updateOne({$set: {u: 1}}); b.find({_id: 1}).deleteOne(); b.find({nope: 1}).delete(); var before = b.toJSON(); var r = b.execute(); [before, r, b.getOperations().length, db.c.find().sort({_id: 1}).toArray()]
###
db = db.getSiblingDB('__DB__'); var b = db.c.initializeUnorderedBulkOp(); b.insert({_id: 1}); b.find({_id: 1}).remove(); b.find({}).removeOne(); b.insert({_id: 2}); print(b); [b.toJSON(), b.execute(), db.c.find().toArray()]
###
db = db.getSiblingDB('__DB__'); var b = db.c.initializeOrderedBulkOp(); b.execute()
###
db = db.getSiblingDB('__DB__'); var b = db.c.initializeOrderedBulkOp(); b.insert({}); b.execute(); b.execute()
###
db = db.getSiblingDB('__DB__'); var b = db.c.initializeOrderedBulkOp(); b.getOperations()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1}, {_id: 2}, {_id: 3}]); [db.c.remove({_id: 1}), db.c.remove({}, true), db.c.remove({}, {justOne: false}), db.c.insert({_id: 7}), db.c.insert([{_id: 8}, {_id: 9}]), db.c.update({_id: 7}, {$set: {a: 1}}), db.c.update({}, {$set: {m: 1}}, {multi: true}), db.c.count(), db.c.count({m: 1}), db.c.find().sort({_id: 1}).toArray()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); [db.c.exists().name, db.nope.exists(), db.c.isCapped(), db.c.drop(), db.c.drop(), db.c.exists(), db.createCollection('cap', {capped: true, size: 1000, max: 5}), db.cap.isCapped(), db.cap.exists().options, db.cap.convertToCapped === undefined, db.c.insertOne({a: 1}).acknowledged, db.c.convertToCapped(8192).ok, db.c.isCapped()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); [db.c.renameCollection('d'), db.getCollectionNames(), db.d.renameCollection('e', true), db.createCollection('f'), db.e.renameCollection('f', true), db.getCollectionNames(), db.f.findOne()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); db.createCollection('d'); db.c.renameCollection('d')
###
db.getSiblingDB('__DB__').nope.renameCollection('x')
###
db.c.renameCollection(5)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 'x'}, {_id: 2, a: 'y'}]); var s = db.c.stats(); var v = db.c.validate(); [s.count, s.nindexes, s.ns, s.scaleFactor, s.capped, s.sharded, typeof s.size, typeof s.avgObjSize, Object.keys(s.indexSizes), db.c.stats(1024).scaleFactor, db.c.stats({scale: 2}).scaleFactor, typeof db.c.dataSize(), typeof db.c.storageSize(), typeof db.c.totalSize(), typeof db.c.totalIndexSize(), v.valid, v.nrecords, v.ns, db.c.validate({full: true}).valid, db.c.validate(true).valid]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); Object.keys(db.c.stats())
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); Object.keys(db.c.stats({indexDetails: true}))
###
db.getSiblingDB('__DB__').nope.stats()
###
db.c.stats({indexDetailsKey: {a: 1}, indexDetailsName: 'x'})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}]); [db.c.runCommand('count').n, db.c.runCommand('count', {query: {a: 5}}).n, db.c.runCommand({count: 'c'}).n, db.c.runCommand('collStats').ns]
###
db.c.runCommand({count: 'c'}, {x: 1})
###
db.c.runCommand('count', {count: 'x'})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, k: 'a', v: 1}, {_id: 2, k: 'a', v: 2}, {_id: 3, k: 'b', v: 3}]); [db.c.mapReduce(function () { emit(this.k, this.v) }, function (k, vs) { return Array.sum(vs) }, {out: {inline: 1}}).results.sort((a, b) => a._id < b._id ? -1 : 1), db.c.mapReduce(function () { emit(this.k, this.v) }, function (k, vs) { return Array.sum(vs) }, {out: {inline: 1}}).ok, db.c.mapReduce(function () { emit(this.k, this.v) }, function (k, vs) { return Array.sum(vs) }, 'mr_out'), db.mr_out.find().sort({_id: 1}).toArray()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); db.c.createIndex({a: 1}); db.c.find({a: 1}).toArray(); var pc = db.c.getPlanCache(); print(pc); [Array.isArray(pc.list()), pc.clear().ok, pc.clearPlansByQuery({a: 1}).ok]
###
db.c.getPlanCache().listQueryShapes()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); [db.c.latencyStats().length, Object.keys(db.c.latencyStats()[0]).sort(), db.c.latencyStats({histograms: true})[0].ns]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); var w = db.c.watch(); var first = w.tryNext(); db.c.insertOne({_id: 2}); db.c.updateOne({_id: 2}, {$set: {a: 1}}); db.c.deleteOne({_id: 1}); var evs = []; for (var i = 0; i < 50 && evs.length < 3; i++) { var e = w.tryNext(); if (e) evs.push(e) } w.close(); [first, evs.map(e => [e.operationType, e.documentKey, e.ns]), typeof w.getResumeToken(), w.isClosed()]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); var w = db.c.watch([{$match: {operationType: 'insert'}}], {fullDocument: 'updateLookup'}); db.c.insertOne({_id: 2, x: 1}); db.c.deleteOne({_id: 2}); db.c.insertOne({_id: 3, x: 2}); var evs = []; for (var i = 0; i < 50 && evs.length < 2; i++) { var e = w.tryNext(); if (e) evs.push(e) } print(w); [evs.map(e => e.fullDocument), w.itcount(), w.isClosed()]
###
db.getSiblingDB('__DB__').c.watch().isExhausted()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, n: 5}, {_id: 2, n: 15}]); [db.c.find({n: {$gt: 10}}).toArray(), db.c.find({$expr: {$gt: ['$n', 10]}}).itcount(), db.c.find({n: {$in: [5, 15]}}).itcount(), db.c.find({$or: [{n: 5}, {_id: 2}]}).itcount(), db.c.find({n: {$not: {$gt: 10}}}).itcount(), db.c.find({n: {$mod: [5, 0]}}).itcount(), db.c.find({n: {$type: 'int'}}).itcount(), db.c.find({n: {$exists: true}}).itcount(), db.c.find({_id: {$nin: [1]}}).itcount(), db.c.find({n: /5/}).itcount(), db.c.find({$where: 'this.n > 10'}).itcount(), db.c.find({$where: function () { return this.n > 10 }}).itcount()]
###
db.c.update({_id: 8}, {whole: 'doc'})
###
db.c.find().sortt({a: 1})
###
var x = {}; x.a.b
###
var x = null; x.a = 1
###
db.c.find({a: 1}).toArray().nope()
###
var x = {}; x.y()
###
var x = {y: {}}; x.y.z( 1,
  2)
###
var x = {}; x
  .yyy()
###
var x = 5; x()
###
var x = {}; new x.K()
###
var f = () => { var o = {}; o.missing(1) }; f()
###
[1,2].map(x => x.foo())
###
var x = {y: {}}; x["y"].nope()
###
var x = [{}]; x[0].nope()
###
db.c.abcdefghijklmnopqrstuvwx.nope()
###
var o = {}; o.a(o.b())
###
var abcdefghijklmnopqrstuvwxyzA = {}; abcdefghijklmnopqrstuvwxyzA.nope()
###
db = db.getSiblingDB('__DB__'); db.createCollection('a'); [db.createView('v', 'a', []), db.createCollection('b', {capped: true, size: 100})]
