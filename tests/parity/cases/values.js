1+1
###
'hello'
###
({s: 'hello', t: "it's", u: 'say "hi"', v: 'a\nb', w: `both ' and "`})
###
[1,2,3]
###
({a: 1, b: {c: [1, 2, {d: 3}]}, e: null, f: undefined, g: true})
###
ObjectId('507f1f77bcf86cd799439011')
###
[NumberLong(5), NumberInt(5), NumberDecimal('1.50'), Double(5), Int32(7), Long('9007199254740993'), Decimal128('0.1')]
###
[ISODate('2024-01-15T10:30:00Z'), new Date(0), Timestamp(1700000000, 1), Timestamp({t: 5, i: 6}), MinKey(), MaxKey(), UUID('0123456789abcdef0123456789abcdef')]
###
[BinData(0, 'aGVsbG8='), HexData(0, '68656c6c6f'), MD5('0123456789abcdef0123456789abcdef'), BSONRegExp('a.*', 'i'), /a.*/gi, BSONSymbol('sym'), Code('function(){ return 1 }'), Code('x', {a: 1}), DBRef('coll', ObjectId('507f1f77bcf86cd799439011')), DBRef('coll', 5, 'otherdb')]
###
null
###
undefined
###
true
###
1.5
###
-0
###
123456789012345680000
###
10n
###
function foo(a, b) { return a + b }
###
(x) => x * 2
###
class Foo { constructor() { this.a = 1 } }; new Foo()
###
new Map([[1, {a: 1}], ['b', 2]])
###
new Set([1, 'two', {three: 3}])
###
Symbol('s')
###
new Error('plain error')
###
[new Uint8Array([1,2,3]), new ArrayBuffer(4), new Float64Array(2)]
###
({a:{b:{c:{d:{e:{f:{g:{h:{i:1}}}}}}}}})
###
Array.from({length: 30}, (_, i) => i)
###
Array.from({length: 120}, (_, i) => i * 1000)
###
Array.from({length: 8}, (_, i) => 'item_' + i)
###
({a: 'x'.repeat(100), b: [1,2,3], c: {d: 'y'.repeat(70)}})
###
Array.from({length: 3}, (_, i) => ({_id: i, name: 'user' + i, tags: ['a', 'b'], nested: {x: i, y: [i, i + 1]}}))
###
db
###
db.coll
###
db.getMongo()
###
typeof db.coll.find
###
[typeof rs, typeof sh, typeof EJSON, typeof BSON, typeof config, typeof Mongo, typeof connect]
###
({ 'key with space': 1, valid_id: 2, 3: 4, 'a-b': 5, $dollar: 6, 'ünï': 7 })
###
'x'.repeat(200)
###
[ 'x'.repeat(100) ]
###
({a: 'line1\nline2\nline3 is here and it is quite long so that it exceeds limits for sure, yes indeed'})
###
[1.0, 2.50, 1e21, 1e-7, NaN, Infinity, -Infinity, 0xff]
###
[[1,[2,[3,[4,[5,[6,[7,[8]]]]]]]]]
###
new Date(NaN)
###
[,1,,2,,,3]
###
Object.create(null)
###
(function(){ var o = {a: 1}; o.self = o; return o })()
