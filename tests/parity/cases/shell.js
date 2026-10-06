db = db.getSiblingDB('__DB__'); db.c.insertOne({_id: 1}); print(db, db.c, db.c.find(), db.c.insertOne({_id: 2}), 'str', 5, [1, 'a'], {a: 'b'}, null, undefined)
###
printjson([1,2,3]); printjson({a: 1, b: 'x', c: [1, {d: 2}]}); printjson('str'); printjson(5); printjson(ObjectId('507f1f77bcf86cd799439011')); printjson({d: new Date(0), l: NumberLong('5'), u: undefined})
###
console.log('a %s b %d c %j', 'S', 42, {x: 1}, 'extra', {y: 2}); console.log(); console.log({a: 1}, [1,2]); console.error('E'); console.info('I'); console.debug('D')
###
db = db.getSiblingDB('__DB__'); db.createCollection('v', {validator: {$jsonSchema: {required: ['name'], properties: {name: {bsonType: 'string'}}}}}); db.v.insertOne({name: 5})
###
db.c.insertOne()
###
db.c.find({$badOp: 1}).toArray()
###
db.c.updateOne({}, {a: 1})
###
throw new Error('custom thrown')
###
throw 'a string'
###
throw {code: 5, msg: 'obj'}
###
undefinedFunction()
###
ObjectId('xyz')
###
NumberDecimal('abc')
###
ISODate('garbage')
###
db.c.find().limit('x')
###
use
###
show
###
show foo
###
db.getSiblingDB('__DB__').createCollection('only'); use __DB__
###
show users
###
show profile
###
show logs
###
it
###
db.c.find({a: 1}).sort({b: -1}).limit(5)
###
var o = 1; for (var i = 0; i < 25; i++) o = {n: o}; print(o); printjson(o); console.log(o)
###
let a = 1; let b = 2; const c = a + b; class K { v() { return c } }; new K().v()
###
[typeof rs, typeof sh, typeof EJSON, typeof config, typeof Mongo, typeof connect, typeof load, typeof sleep, typeof isInteractive, typeof passwordPrompt, typeof version, typeof it, typeof show, typeof use, typeof cls, typeof quit, typeof exit, typeof help, typeof setTimeout, typeof atob, typeof btoa, typeof bsonsize, typeof DBQuery]
###
isInteractive()
###
[1, 2, 3].map(x => x * 2).filter(x => x > 2).reduce((a, b) => a + b, 0)
###
await Promise.resolve(42)
###
(async () => { const r = await Promise.all([1, 2].map(async x => x * 2)); return r })()
###
JSON.stringify({a: 1, b: [1, 2], c: 'x'})
###
new Date(0).toISOString()
###
typeof db.c.find().toArray
###
db.getSiblingDB('__DB__').c.insertOne({a: 1}).acknowledged
###
EJSON.stringify({a: 1, o: ObjectId('507f1f77bcf86cd799439011'), d: new Date(0), l: NumberLong('5'), n: NumberInt(3), dec: NumberDecimal('1.5'), b: BinData(0, 'aGVsbG8='), t: Timestamp(1, 2), r: /a/i, u: UUID('01234567-89ab-cdef-0123-456789abcdef'), mk: MinKey(), f: 1.5, big: 12345678901234})
###
EJSON.stringify({a: 1, o: ObjectId('507f1f77bcf86cd799439011'), d: new Date(0), l: NumberLong('5'), n: NumberInt(3), dec: NumberDecimal('1.5'), b: BinData(0, 'aGVsbG8='), t: Timestamp(1, 2), r: /a/i, mk: MinKey(), f: 1.5, big: 12345678901234}, {relaxed: false})
###
EJSON.parse('{"a": {"$numberLong": "5"}, "b": {"$oid": "507f1f77bcf86cd799439011"}, "c": {"$date": "2020-01-01T00:00:00Z"}, "d": {"$numberDecimal": "1.5"}, "e": 5, "f": {"$numberInt": "7"}}')
###
EJSON.parse('{"a": {"$numberLong": "5"}, "b": {"$oid": "507f1f77bcf86cd799439011"}, "c": {"$date": {"$numberLong": "0"}}, "e": 5, "f": 1.5, "g": {"$numberDouble": "2.0"}}', {relaxed: false})
###
EJSON.serialize({l: NumberLong('5'), d: new Date(0)})
###
[bsonsize({a: 1}), bsonsize({a: 'hello', b: [1, 2, 3], c: {d: new Date()}})]
