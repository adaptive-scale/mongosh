var o = ObjectId('507f1f77bcf86cd799439011'); [o.toString(), o.toHexString(), o.getTimestamp(), o.equals(ObjectId('507f1f77bcf86cd799439011')), o.equals('507f1f77bcf86cd799439011'), JSON.stringify(o), o instanceof ObjectId, typeof o.id, o.id.length, ObjectId.isValid('zzz'), ObjectId.isValid('507f1f77bcf86cd799439011'), String(o), `${o}`, o + '']
###
[ObjectId.createFromTime(1).toHexString(), ObjectId.createFromHexString('507f1f77bcf86cd799439011'), ObjectId(1700000000).getTimestamp(), ObjectId().toHexString().length, ObjectId('507F1F77BCF86CD799439011')]
###
var l = NumberLong('9007199254740993'); [l.toString(), l.toNumber(), l.add(1).toString(), l.subtract(NumberLong('3')).toString(), l.multiply(2).toString(), l.div(2).toString(), l.modulo(10).toString(), l.negate().toString(), l.compare(5), l.equals(NumberLong('9007199254740993')), l.greaterThan(1), l.lessThan(1), l.isZero(), l.isNegative(), l.isOdd(), l.toInt(), l.getHighBits(), l.getLowBits(), l.shiftRight(3).toString(), l.shiftLeft(2).toString(), l.and(255).toString(), l.or(1).toString(), l.xor(1).toString(), l.not().toString(), l.toBigInt(), JSON.stringify(l), l instanceof Long, l instanceof NumberLong, String(l), l + 1]
###
[Long.fromNumber(5), Long.fromString('ff', 16), Long.fromString('-12'), Long.fromBits(1, 2), Long.fromInt(-1), Long.fromBigInt(5n), Long.MAX_VALUE, Long.MIN_VALUE, Long.ZERO, Long.ONE, Long.NEG_ONE, Long.MAX_UNSIGNED_VALUE, Long.isLong(Long.ONE), Long.isLong(5), Long(5, 6), Long('77'), Long(5n), new Long(1,2,true), Long.fromNumber(-5, true), Long.fromNumber(1e30), Long.fromNumber(NaN)]
###
[NumberLong(), NumberLong('123'), NumberLong(NumberInt(5)), NumberInt(), NumberInt('42'), NumberInt(3.7), NumberInt(-3.7), Int32('5'), Int32(5).valueOf(), Int32(5) + 1, JSON.stringify(Int32(5)), Double(1.5), Double('2.5'), Double(3).valueOf(), Double(5) + 1, JSON.stringify({d: Double(5)}), Int32(5).toString(), Double(5.5).toString()]
###
[NumberDecimal('1.50').toString(), NumberDecimal('1E+3'), NumberDecimal('0.000001'), NumberDecimal('-0'), NumberDecimal('NaN'), NumberDecimal('Infinity'), NumberDecimal('12345678901234567890.123456789'), Decimal128.fromString('2.5'), JSON.stringify(NumberDecimal('1.5')), NumberDecimal('1.5') instanceof Decimal128, String(NumberDecimal('9.99')), NumberDecimal(NumberLong('5')), NumberDecimal('1e-10'), NumberDecimal('123E-2'), NumberDecimal('0.0'), NumberDecimal('1000000000000000000000000000000000000')]
###
var t = Timestamp(100, 5); [t, t.t, t.i, t.getHighBits(), t.getLowBits(), t.toString(), JSON.stringify(t), Timestamp(), Timestamp({t: 1, i: 2}), Timestamp(Long(7, 8)), t instanceof Timestamp, t.equals(Timestamp(100, 5)), t.compare(Timestamp(100, 6)), t.toNumber()]
###
var b = BinData(0, 'aGVsbG8gd29ybGQ='); [b, b.sub_type, b.length(), b.toString(), b.toString('hex'), b.toString('base64'), JSON.stringify(b), b.buffer.length, b.position, b instanceof Binary, Binary.createFromBase64('AAEC', 5), Binary.createFromHexString('00ff', 2), new Binary(new Uint8Array([1,2,3])), BinData(4, 'ASNFZ4mrze8BI0VniavN7w=='), BinData(3, 'ASNFZ4mrze8BI0VniavN7w=='), BinData(4, 'AAEC'), HexData(128, 'abcd')]
###
var u = UUID('01234567-89ab-cdef-0123-456789abcdef'); [u, u.toString(), JSON.stringify(u), u.sub_type, UUID().toString().length > 0, UUID().sub_type, u.toString('hex'), u.toString('base64'), u.length(), u instanceof Binary]
###
[MD5('0123456789abcdef0123456789abcdef'), LegacyJavaUUID('01234567-89ab-cdef-0123-456789abcdef'), LegacyCSharpUUID('01234567-89ab-cdef-0123-456789abcdef'), LegacyPythonUUID('01234567-89ab-cdef-0123-456789abcdef')]
###
[MinKey(), MaxKey(), new MinKey(), JSON.stringify({a: MinKey(), b: MaxKey()}), MinKey() instanceof MinKey, BSONSymbol('abc').toString(), BSONSymbol('abc').valueOf(), JSON.stringify(BSONSymbol('abc')), BSONRegExp('ab+', 'imx'), BSONRegExp('a').options, JSON.stringify(BSONRegExp('ab+', 'i')), Code('x'), Code(function f() { return 1 }), Code('x', {a: 1}).scope, JSON.stringify(Code('x')), JSON.stringify(Code('x', {a: 1}))]
###
var r = DBRef('coll', ObjectId('507f1f77bcf86cd799439011'), 'mydb'); [r, r.collection, r.namespace, r.oid, r.db, JSON.stringify(r), r.fields, DBRef('a.b', 1), DBRef('c', 1, undefined, {x: 1}), DBRef('c', 1, 'd', {x: 1})]
###
[ISODate('2020-01-01'), ISODate('2020-01-01T10:20:30Z'), ISODate('2020-01-01T10:20:30.123Z'), ISODate('2020-01-01 10:20'), ISODate('20200101T102030Z'), ISODate('2020-01-01T10:20:30+05:30'), ISODate('2020-01-01T10:20:30-0800'), ISODate('2020-01-01T10:20:30.123456Z'), ISODate('2020-01-01T10'), ISODate('0001-01-01'), ISODate('9999-12-31T23:59:59.999Z'), ISODate(0), ISODate(new Date(5)), ISODate('2020-02-30')]
###
ISODate('2020-01-01T10:20:30+05')
###
ISODate('2020-13-01')
###
ISODate('2020-01-01T25:00:00Z')
###
ISODate('99999-01-01')
###
[typeof Date(), new Date(Date.UTC(2020, 0, 15, 10, 30)).getUTCFullYear(), new Date('2020-06-15T12:00:00Z'), new Date(1577836800000), Date.UTC(2020, 0, 1), new Date('2020-01-01').getTime()]
###
NumberLong({})
###
NumberInt({})
###
Timestamp('x')
###
Timestamp({t: -1, i: 1})
###
UUID('zz')
###
UUID(5)
###
BinData('x', 'aa')
###
Long.fromString('')
###
Long.fromString('1-2')
###
Long.ONE.div(0)
###
Decimal128('nope')
###
Decimal128(5)
###
BSONRegExp('a', 'q')
###
ObjectId('507f1f77bcf86cd79943901')
###
ObjectId({})
###
[NumberLong(5), NumberLong(6), NumberDecimal(1.5)]
###
[typeof ObjectId.help, typeof ObjectId().help, typeof NumberLong.help]
###
ObjectId().help()
###
DBRef('c', 1, null)
###
Code(5)
###
ObjectId(true)
###
Binary('abc', 0)
###
[BSONSymbol(5), MinKey(1), Int32('abc'), Double('abc'), Long('abc'), NumberLong('abc'), NumberInt('abc'), Int32(5.7), Int32(-5.7), Int32(2**31), Long(5.9), Long(-5.9), BSONRegExp('a', 'xi'), Code(), BSONSymbol()]
###
Object.keys(Long(5)).concat(Object.keys(Timestamp(1,2)), Object.keys(Int32(5)), Object.keys(Double(5)), Object.keys(NumberDecimal('1')), Object.keys(BinData(0, 'aa')), Object.keys(MinKey()), Object.keys(BSONRegExp('a')), Object.keys(Code('x')), Object.keys(DBRef('a', 1)), Object.keys(BSONSymbol('s')), Object.keys(ObjectId()))
###
db = db.getSiblingDB('__DB__'); db.t.insertOne({_id: 1, u: UUID('01234567-89ab-cdef-0123-456789abcdef')}); var x = db.t.findOne().u; [x.toString(), JSON.stringify(x), x.constructor.name, Object.keys(x), x.toHexString !== undefined, x.equals(x), x.toBinary().sub_type]
