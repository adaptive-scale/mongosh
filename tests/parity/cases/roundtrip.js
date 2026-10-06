db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, i: 5, d: 5.5, bigd: 5000000000, neg0: -0, l: NumberLong('5'), l2: NumberLong('9007199254740993'), ni: NumberInt(7), dbl: Double(3), dec: NumberDecimal('1.50'), s: 'str', b: true, n: null, u: undefined, date: ISODate('2020-01-01T00:00:00Z'), oid: ObjectId('507f1f77bcf86cd799439011'), ts: Timestamp(1, 2), bin: BinData(0, 'aGVsbG8='), uuid: UUID('01234567-89ab-cdef-0123-456789abcdef'), md5: MD5('0123456789abcdef0123456789abcdef'), mink: MinKey(), maxk: MaxKey(), re: /ab+c/i, re2: /x/gm, bre: BSONRegExp('a', 'i'), sym: BSONSymbol('sym'), code: Code('function() {}'), codes: Code('x', {a: 1}), ref: DBRef('c', 5), ref2: DBRef('c', ObjectId('507f1f77bcf86cd799439011'), 'otherdb'), arr: [1, 'a', {b: NumberLong('1')}, [2]], nested: {a: {b: {c: 1}}}, fn: function (a) { return a + 1 }, bigint: 12n, u8: new Uint8Array([1, 2, 3]), nan: NaN, inf: Infinity, emptyObj: {}, emptyArr: [], int32max: 2147483647, int32over: 2147483648, int32min: -2147483648, float: 1.0, exp: 1e21}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, i: 5, d: 5.5, bigd: 5000000000, neg0: -0, l: NumberLong('5'), ni: NumberInt(7), dbl: Double(3), dec: NumberDecimal('1.50'), s: 'str', b: true, n: null, u: undefined, date: ISODate('2020-01-01T00:00:00Z'), oid: ObjectId('507f1f77bcf86cd799439011'), ts: Timestamp(1, 2), bin: BinData(0, 'aGVsbG8='), uuid: UUID('01234567-89ab-cdef-0123-456789abcdef'), mink: MinKey(), maxk: MaxKey(), re: /ab+c/i, bre: BSONRegExp('a', 'i'), sym: BSONSymbol('sym'), code: Code('function() {}'), codes: Code('x', {a: 1}), ref: DBRef('c', 5), arr: [1], nested: {a: 1}, fn: function (a) { return a + 1 }, bigint: 12n, u8: new Uint8Array([1, 2, 3]), nan: NaN, int32max: 2147483647, int32over: 2147483648, float: 1.0, mk: MinKey, date2: new Date(5)}); db.t.aggregate([{$project: {_id: 0, types: {$arrayToObject: {$map: {input: {$objectToArray: '$$ROOT'}, in: {k: '$$this.k', v: {$type: '$$this.v'}}}}}}}]).next().types
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, l: NumberLong('5'), d: new Date(0), dec: NumberDecimal('1.5')}); var doc = db.t.findOne(); [doc.l instanceof Long, doc.l.toNumber() + 1, doc.d instanceof Date, doc.d.getTime(), doc.dec.toString(), typeof doc._id, Object.keys(doc), JSON.stringify(doc)]
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({a: 1}); var doc = db.t.findOne(); [doc._id instanceof ObjectId, doc._id.toHexString().length, Object.keys(doc._id), doc._id.equals(db.t.findOne()._id)]
###
db = db.getSiblingDB('__DB__'); var d = {a: 1}; db.t.insertOne(d); [Object.keys(d), d._id instanceof ObjectId]
###
db = db.getSiblingDB('__DB__'); var docs = [{a: 1}, {a: 2, _id: 'x'}]; var r = db.t.insertMany(docs); [docs.map(d => typeof d._id), Object.keys(r.insertedIds), r.insertedIds[1]]
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, '': 'empty key', 'a.b': 1, $x: 2, 'with space': 3, 'ünï': 4, 0: 'zero', 10: 'ten', 2: 'two', z: 1, a: 2}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, s: 'multi\nline\tand "quotes" and \'single\' and \\ backslash and unicode é 中文 😀'}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, big: 'x'.repeat(300), arr: Array.from({length: 150}, (_, i) => i)}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, ref: {$ref: 'coll', $id: 5}, notref: {$ref: 'coll', $id: 5, $other: 1}, ref3: {$ref: 'c', $id: 1, $db: 'd', extra: 2}}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, deep: {a: {b: {c: {d: {e: {f: {g: {h: {i: {j: 'deep'}}}}}}}}}}}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); db.t.insertMany([{_id: 1, v: NumberLong('5')}, {_id: 2, v: 5}, {_id: 3, v: 5.5}, {_id: 4, v: NumberDecimal('5')}, {_id: 5, v: '5'}]); db.t.find({v: 5}).sort({_id: 1}).toArray()
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, n: 1}); db.t.updateOne({_id: 1}, {$inc: {n: NumberLong('1')}}); db.t.updateOne({_id: 1}, {$set: {big: 2 ** 40, when: new Date(86400000)}}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); var cyc = {a: 1}; cyc.self = cyc; db.t.insertOne(cyc)
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({a: new Date(NaN)})
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, a: {toBSON() { return {replaced: true} }}, s: Symbol('x'), set: new Set([1, 2]), err: new Error('e'), cls: new (class P { constructor() { this.x = 1 } })()}); db.t.findOne()
###
db = db.getSiblingDB('__DB__'); var op = {insertOne: {document: {a: 1}}}; db.t.bulkWrite([op]); var d2 = {b: 1}; db.t.insertMany([d2]); var b = db.t.initializeOrderedBulkOp(); var d3 = {c: 1}; b.insert(d3); b.execute(); [Object.keys(op.insertOne.document), Object.keys(d2), Object.keys(d3)]
