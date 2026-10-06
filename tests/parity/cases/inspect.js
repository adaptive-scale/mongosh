Array.from({length: 7}, (_, i) => i)
###
Array.from({length: 6}, (_, i) => i)
###
Array.from({length: 101}, (_, i) => i)
###
Array.from({length: 26}, (_, i) => 'x'.repeat(i))
###
Array.from({length: 12}, (_, i) => -i * 1.5)
###
Array.from({length: 10}, (_, i) => i % 2 ? 'str' + i : i)
###
Array.from({length: 10}, (_, i) => Array.from({length: 10}, (_, j) => i * j))
###
Array.from({length: 8}, (_, i) => ({a: i}))
###
Array.from({length: 8}, (_, i) => ({a: i, b: 'some longer string value ' + i, c: [i, i]}))
###
Array.from({length: 9}, (_, i) => [i])
###
Array.from({length: 20}, (_, i) => ObjectId('507f1f77bcf86cd7994390' + (10 + i)))
###
Array.from({length: 7}, (_, i) => new Date(i * 86400000))
###
Array.from({length: 7}, (_, i) => NumberLong(String(i)))
###
[true, false, null, undefined, true, false, null, undefined]
###
['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh', 'iiiiiiiii']
###
[1, 22, 333, 4444, 55555, 666666, 7777777, 88888888, 999999999, 1e10]
###
[0.1, 0.25, 1/3, 2/3, 1e-7, 1e21, 123456.789, -0, 5, 100]
###
[1n, 22n, 333n, 4444n, 55555n, 666666n, 7777777n]
###
['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30)]
###
['x'.repeat(74)]
###
['x'.repeat(75)]
###
({k: 'x'.repeat(72)})
###
({k: 'x'.repeat(73)})
###
({aaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbb: 2, cccccccccccccccccccc: 3, d: 4})
###
({aaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbb: 2, cccccccccccccccccccc: 3, dd: 4})
###
({a: {b: {c: {}}}})
###
({a: {b: {c: {d: 1}}}})
###
({a: [[[]]]})
###
({a: [[[[1]]]]})
###
({a: {}, b: [], c: {d: {}, e: []}})
###
[[], {}, [[]], [{}], {a: []}, {a: {}}]
###
({s: 'it\'s', d: "say \"hi\"", b: 'both \' and "', t: 'all \' " `', n: 'new\nline', tab: 'a\tb', bs: 'back\\slash', ctl: '\x00\x01\x1f\x7f', uni: 'é中😀', lone: '\ud800', empty: ''})
###
({'': 1, ' ': 2, 'a b': 3, 'a-b': 4, a_b: 5, $a: 6, _a: 7, '9a': 8, a9: 9, 'ä': 10, 'a.b': 11, class: 12, 'it\'s': 13, [Symbol('sym')]: 14, [Symbol.for('reg')]: 15})
###
new Map([['a', 1], [{k: 1}, [1, 2]], [3, new Map([[1, 2]])]])
###
new Map()
###
new Set()
###
new Set([[1, 2], {a: 1}, 'str', new Set([1])])
###
({m: new Map([[1, {a: {b: {c: 1}}}]]), s: new Set(Array.from({length: 10}, (_, i) => i))})
###
class Point { constructor(x, y) { this.x = x; this.y = y } }; [new Point(1, 2), new (class extends Point {})(3, 4), new (class {})(), Point, class {}, class A extends Point {}]
###
[function () {}, function named() {}, () => {}, async () => {}, function* gen() {}, async function af() {}, Math.max, class Foo {}, Symbol, Object.assign(function withProps() {}, {a: 1})]
###
[Symbol(), Symbol('desc'), Symbol.for('global'), Symbol.iterator]
###
[new Number(5), new String('str'), new Boolean(false), Object(1n), Object(Symbol('s'))]
###
[new Error('e1'), new TypeError('e2'), new RangeError('e3')].map(e => e.name + ':' + e.message)
###
({e: Object.assign(new Error('with props'), {code: 42})}).e.code
###
[/regex/, /with flags/gimsuy, new RegExp('a/b'), /\d+\.\d*/]
###
[new Uint8Array(0), new Uint8Array([1, 2, 3]), new Int16Array([-1, 2]), new Float32Array([1.5]), new BigInt64Array([1n]), new Uint8Array(120), new ArrayBuffer(0), new ArrayBuffer(3), new DataView(new ArrayBuffer(2)).byteLength]
###
[new WeakMap(), new WeakSet(), Promise.resolve(5).constructor.name]
###
var a = [1, 2, 3]; a.extra = 'prop'; a
###
var a = []; a[5] = 1; a
###
var a = [1, 2, 3]; a.length = 10; a
###
var a = [1]; a.push(a); a
###
var o = {name: 'o'}; var p = {name: 'p', o}; o.p = p; [o, p]
###
var o = {}; Object.defineProperty(o, 'hidden', {value: 1, enumerable: false}); Object.defineProperty(o, 'getter', {get() { return 1 }, enumerable: true}); Object.defineProperty(o, 'setter', {set(v) {}, enumerable: true}); Object.defineProperty(o, 'both', {get() { return 1 }, set(v) {}, enumerable: true}); o
###
var o = Object.create(null); o.a = 1; [o, Object.create({inherited: 1}), Object.create(Object.create(null))]
###
({toString() { return 'custom' }, valueOf() { return 42 }})
###
({[Symbol.toStringTag]: 'Tagged', a: 1})
###
(function () { return arguments })(1, 'two', {three: 3})
###
[globalThis === this, typeof globalThis]
###
({und: undefined, nul: null, nan: NaN, inf: -Infinity, zero: 0, negzero: -0, t: true, f: false, e: '', big: 2 ** 53, small: 5e-324, max: Number.MAX_VALUE})
###
({a: 1, b: 'two', c: [3], d: {e: 4}, f: null, g: undefined, h: true, i: 1.5, j: NumberLong('6'), k: new Date(0), l: /re/, m: ObjectId('507f1f77bcf86cd799439011')})
###
[[1, 2, [3, 4, [5, 6, [7, 8, [9, 10]]]]], {a: [{b: [{c: [{d: [1]}]}]}]}]
###
({doc: {_id: ObjectId('507f1f77bcf86cd799439011'), name: 'Alice', email: 'alice@example.com', age: 30, tags: ['admin', 'user'], address: {street: '123 Main St', city: 'Springfield', zip: '12345'}, createdAt: new Date(0)}})
###
Array.from({length: 3}, (_, i) => ({_id: ObjectId('507f1f77bcf86cd79943901' + i), name: 'User ' + i, email: `user${i}@example.com`, active: i % 2 === 0, scores: [i * 10, i * 20, i * 30], profile: {bio: 'x'.repeat(40), links: []}}))
###
'a string ' + 'result'
###
'multi\nline\n' + 'string'
###
''
###
[''].concat([' ', '  '])
###
0
###
false
###
123456789.123456789
###
0.1 + 0.2
###
2 ** 64
###
-1e-7
###
0xff + 0b11 + 0o17
###
[1e21, 1e-7, 123e-20, 1.0, 100, 1e5, 123456789012345680000, 0.000001, 0.0000001]
###
({a: 'x'.repeat(10001)}).a.length
###
Array.from({length: 4}, (_, i) => 'line' + i).join('\n')
###
({text: Array.from({length: 4}, (_, i) => 'line number ' + i + ' with padding').join('\n')})
###
({short: 'a\nb'})
###
['a\nb', 'c']
###
({a: 1, 'b': 2, 3: 'three', 1: 'one', 2.5: 'x', '-1': 'neg', '01': 'lead'})
