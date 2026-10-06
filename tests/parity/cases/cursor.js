db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.find().sort({_id: -1}).limit(3)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.find({}, {s: 0}).skip(27).sort({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.find().projection({s: 1, _id: 0}).limit(2).sort({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.find().batchSize(5).sort({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); var c = db.c.find().sort({_id:1}).batchSize(7); [c.objsLeftInBatch(), c.hasNext(), c.objsLeftInBatch(), c.next()._id, c.objsLeftInBatch(), c.isClosed(), c.isExhausted(), c.toArray().length, c.isClosed(), c.isExhausted(), c.hasNext(), c.next(), c.tryNext(), c.objsLeftInBatch()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); [db.c.find({g: 0}).count(), db.c.find().skip(5).limit(10).count(), db.c.find().skip(5).limit(10).size(), db.c.find().skip(5).limit(10).itcount(), db.c.find({g: 9}).count(), db.c.find().itcount()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); var seen = []; db.c.find().sort({_id: 1}).forEach(d => { seen.push(d._id); if (d._id === 3) return false }); var m = db.c.find().sort({_id: 1}).limit(3).map(d => d.s).map(s => s.toUpperCase()); [seen, m.toArray(), db.c.find().limit(2).sort({_id: 1}).map(d => d._id * 2).next()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); [db.c.find().sort('g').limit(1).next().g, db.c.find().sort([['g', -1], ['_id', 1]]).limit(1).next()._id, db.c.find().sort({g: 'desc', _id: 'asc'}).limit(1).next()._id, db.c.find().sort('g', -1).limit(1).next().g, db.c.find().sort({g: -1, _id: -1}).limit(1).next()._id]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.find().sort({_id: 1}).limit(-3)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); db.c.createIndex({g: 1}); [db.c.find({g: 1}).hint({g: 1}).itcount(), db.c.find({g: 1}).hint('g_1').itcount(), db.c.find().min({g: 1}).max({g: 2}).hint({g: 1}).itcount(), db.c.find().comment('hi').maxTimeMS(5000).itcount(), db.c.find({s: 'V1'}).collation({locale: 'en', strength: 2}).itcount(), db.c.find().readConcern('local').itcount(), db.c.find({g: 0}).hint({g: 1}).returnKey().limit(1).next(), Object.keys(db.c.find().showRecordId().limit(1).next()), db.c.find().sort({_id: 1}).allowDiskUse().noCursorTimeout().allowPartialResults().limit(2).itcount(), db.c.find().sort({_id: 1}).pretty().limit(1).next()._id]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3, s: 'v' + i}))); [Object.keys(db.c.find({g: 1}).explain('executionStats')).includes('executionStats'), Object.keys(db.c.find({g: 1}).explain(true)).includes('executionStats'), db.c.find({g: 1}).sort({_id: 1}).limit(2).explain().queryPlanner.namespace, db.c.find({g: 1}).explain('queryPlanner').command.filter, db.c.find({g: 1}).skip(2).limit(3).explain().command]
###
db.c.find().skip('x')
###
db.c.find().batchSize('x')
###
db.c.find().maxTimeMS('x')
###
db.c.find().maxScan(5)
###
JSON.stringify(db.c.find())
###
db.c.find().sort({a: 'sideways'})
###
db.c.find().sort(5)
###
db.c.find().allowDiskUse()
###
db.c.find().addOption(4)
###
db.c.find().explain(5)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany([{_id: 1}, {_id: 2}, {_id: 3}]); var c = db.c.find(); c.next(); c.limit(5)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find().batchSize(2); c.next(); c.close(); [c.isClosed(), c.isExhausted(), c.hasNext(), c.objsLeftInBatch(), c.toArray()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3}))); [db.c.aggregate([{$match: {g: 1}}, {$sort: {_id: 1}}]).toArray().length, db.c.aggregate([{$group: {_id: '$g', n: {$sum: 1}}}, {$sort: {_id: 1}}]).toArray(), db.c.aggregate([{$sort: {_id: 1}}], {allowDiskUse: true, batchSize: 4}).next(), db.c.aggregate({$match: {g: 2}}, {$count: 'n'}).next(), db.c.aggregate([]).itcount(), db.c.aggregate().hasNext()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3}))); db.c.aggregate([{$sort: {_id: 1}}]).batchSize(4)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3}))); var a = db.c.aggregate([{$sort: {_id: 1}}], {batchSize: 4}); [a.objsLeftInBatch(), a.next()._id, a.objsLeftInBatch(), a.isClosed(), a.isExhausted(), a.map(d => d._id).toArray().length, a.isExhausted(), a.hasNext()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 30}, (_, i) => ({_id: i, g: i % 3}))); [db.c.aggregate([{$match: {g: 0}}, {$out: 'outc'}]).toArray(), db.outc.countDocuments(), db.c.aggregate([{$match: {g: 1}}, {$merge: {into: 'outc'}}]).hasNext(), db.outc.countDocuments()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 6}, (_, i) => ({_id: i, g: i % 3}))); var e = db.c.aggregate([{$match: {g: 1}}], {explain: true}); var e2 = db.c.aggregate([{$match: {g: 1}}]).explain('executionStats'); [typeof e, Object.keys(e).includes('ok'), Object.keys(e2).includes('ok'), db.c.explain().aggregate([{$match: {g: 1}}]).ok, db.c.explain('executionStats').count({g: 1}).ok, db.c.explain().distinct('g').ok, db.c.explain().remove({g: 1}).ok, db.c.explain().update({g: 1}, {$set: {x: 1}}).ok, db.c.explain().findAndModify({query: {g: 1}, update: {$set: {y: 1}}}).ok, db.c.explain().getVerbosity(), db.c.explain('executionStats').getVerbosity(), db.c.explain().getCollection().getName(), db.c.countDocuments({x: 1})]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 6}, (_, i) => ({_id: i, g: i % 3}))); var x = db.c.explain('executionStats').find({g: 1}).sort({_id: -1}).limit(2); [x.constructor.name, typeof x.finish, Object.keys(x.finish()).includes('executionStats')]
###
db = db.getSiblingDB('__DB__'); db.createCollection('cap', {capped: true, size: 4096}); db.cap.insertMany([{_id: 1}, {_id: 2}]); var t = db.cap.find().tailable(); [t.next()._id, t.next()._id, t.tryNext(), t.isClosed(), t.isExhausted()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 250}, (_, i) => ({_id: i}))); var c = db.c.find().sort({_id: 1}); [c.objsLeftInBatch(), c.next()._id, c.objsLeftInBatch(), c.isClosed(), c.itcount(), c.isClosed()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 5}, (_, i) => ({_id: i}))); var out = []; for await (const d of db.c.find().sort({_id: 1})) out.push(d._id); out
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find().batchSize(2); c.next(); c.close(); c.next()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find().batchSize(2); c.next(); c.close(); c.tryNext()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find(); c.toArray(); [c.hasNext(), c.next(), c.tryNext(), c.toArray(), c.itcount(), c.isClosed(), c.isExhausted()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find(); c.close(); [c.toArray(), c.hasNext()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var c = db.c.find().sort({_id: 1}); [c.isClosed(), c.next()._id, c.isClosed(), c.objsLeftInBatch(), c.isExhausted()]
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 10}, (_, i) => ({_id: i}))); var w = db.c.watch(); db.c.insertOne({_id: 99}); print(w.next().operationType); db.c.insertOne({_id: 98}); print(w.hasNext()); print(w.next().operationType); w.close(); w.tryNext()
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 45}, (_, i) => ({_id: i}))); db.c.find().sort({_id: 1}).skip(30)
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 20}, (_, i) => ({_id: i}))); db.c.find().sort({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 21}, (_, i) => ({_id: i}))); db.c.find().sort({_id: 1})
###
db = db.getSiblingDB('__DB__'); db.c.insertMany(Array.from({length: 25}, (_, i) => ({_id: i}))); db.c.aggregate([{$sort: {_id: 1}}])
