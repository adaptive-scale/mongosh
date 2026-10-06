var o = 1; for (var i = 0; i < 25; i++) o = {n: o}; o
###
var o = 1; for (var i = 0; i < 25; i++) o = {n: o}; print(o); printjson(o); console.log(o)
###
"hello"
###
'hello' + 1
###
MinKey
###
ObjectId
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1, a: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}, {a: 3}])
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.updateOne({_id: 1}, {$set: {a: 5}})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.updateMany({}, {$inc: {a: 1}})
###
db = db.getSiblingDB('__DB__'); db.c.updateOne({_id: 9}, {$set: {a: 5}}, {upsert: true})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.replaceOne({_id: 1}, {b: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.deleteOne({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.deleteMany({})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.find()
###
db = db.getSiblingDB('__DB__'); db.c.find()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 45}, (_, i) => ({_id: i}))); db.c.find()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 45}, (_, i) => ({_id: i}))); db.c.find().toArray().length
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.aggregate([{$group: {_id: null, s: {$sum: '$a'}}}])
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.findOne()
###
db = db.getSiblingDB('__DB__'); db.c.findOne()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); [db.c.countDocuments(), db.c.estimatedDocumentCount(), db.c.count(), db.c.find().count(), db.c.distinct('a')]
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); db.c.insertOne({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1}, {_id: 1}, {_id: 2}])
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1}, {_id: 1}, {_id: 2}], {ordered: false})
###
db = db.getSiblingDB('__DB__'); db.c.createIndex({a: 1})
###
db = db.getSiblingDB('__DB__'); db.c.createIndex({a: 1}, {unique: true, name: 'aidx'}); db.c.getIndexes()
###
db = db.getSiblingDB('__DB__'); db.c.createIndexes([{a: 1}, {b: -1}])
###
db = db.getSiblingDB('__DB__'); db.c.createIndex({a: 1}); db.c.dropIndex('a_1')
###
db = db.getSiblingDB('__DB__'); db.c.createIndex({a: 1}); db.c.dropIndexes()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); db.c.drop()
###
db = db.getSiblingDB('__DB__'); db.nonexistent.drop()
###
db = db.getSiblingDB('__DB__'); db.createCollection('x')
###
db = db.getSiblingDB('__DB__'); db.createCollection('x'); db.createCollection('y'); db.getCollectionNames().sort()
###
db = db.getSiblingDB('__DB__'); db.createCollection('x'); db.getCollectionInfos()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); db.dropDatabase()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); db.c.renameCollection('d')
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.bulkWrite([{insertOne: {document: {_id: 3}}}, {updateOne: {filter: {_id: 1}, update: {$set: {a: 9}}}}, {deleteOne: {filter: {_id: 2}}}, {updateOne: {filter: {_id: 7}, update: {$set: {a: 9}}, upsert: true}}])
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); [db.c.findOneAndUpdate({_id: 1}, {$set: {a: 5}}), db.c.findOneAndUpdate({_id: 1}, {$set: {a: 6}}, {returnDocument: 'after'}), db.c.findOneAndReplace({_id: 2}, {z: 1}, {returnNewDocument: true}), db.c.findOneAndDelete({_id: 1}), db.c.findOneAndDelete({_id: 99})]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.findAndModify({query: {_id: 1}, update: {$set: {a: 7}}, new: true})
###
db.runCommand({ping: 1})
###
db.adminCommand({ping: 1})
###
db.runCommand({nonExistentCommand: 1})
###
db.version()
###
typeof version()
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); var s = db.stats(); Object.keys(s)
###
db = db.getSiblingDB('__DB__'); db.c.insertOne({a: 1}); var s = db.c.stats(); Object.keys(s)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); Object.keys(db.c.find({a: 1}).explain())
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.find({a: 1}).explain().queryPlanner.winningPlan
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.explain().find({a: 1}).queryPlanner.namespace
###
db = db.getSiblingDB('__DB__'); db.c.explain()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.find().sort({_id: -1}).map(d => d.a)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); var c = db.c.find(); [c.hasNext(), c.next(), c.next(), c.hasNext(), c.isExhausted(), c.isClosed()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1, a: 1}, {_id: 2, a: 2}]); db.c.find().forEach(d => print(d))
