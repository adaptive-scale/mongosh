// BSON value classes and the shell's type constructors (ObjectId, NumberLong,
// ISODate, ...). The classes mirror the Node.js BSON library that mongosh
// exposes: same constructors, methods, `_bsontype` tags and printed form.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const native = msh.native;
  const bytes = msh.bytes;
  const inspectCustom = msh.symbols.inspectCustom;

  class BSONError extends Error {
    constructor(message) {
      super(message);
    }
    get name() {
      return 'BSONError';
    }
    get bsonError() {
      return true;
    }
    static isBSONError(value) {
      return value != null && typeof value === 'object' && value.bsonError === true;
    }
  }

  /** Give a class its `_bsontype` tag and printed form without own properties. */
  function describe(ctor, bsontype, print) {
    Object.defineProperty(ctor.prototype, '_bsontype', { get: () => bsontype, enumerable: false, configurable: true });
    Object.defineProperty(ctor.prototype, inspectCustom, { value: print, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(ctor.prototype, 'inspect', { value: print, enumerable: false, writable: true, configurable: true });
  }

  /** Format a part of a BSON value, coloured like mongosh when colours are on. */
  const show = (value, options) => msh.inspect(value, options && options.colors ? { colors: true } : undefined);

  function typeName(value) {
    if (value !== null && typeof value === 'object' && value._bsontype) return `bson:${value._bsontype}`;
    return typeof value;
  }

  /** Argument type checks with the shell's error wording. */
  function assertArgs(args, expected, func) {
    args.forEach((value, i) => {
      const allowed = expected[i];
      if (allowed === undefined || allowed === true) return;
      if (value === undefined) {
        if (allowed.includes(undefined) || allowed.includes(null)) return;
        throw msh.invalidInput(`Missing required argument at position ${i} (${func})`);
      }
      const actual = typeName(value);
      if (allowed.includes(actual) || allowed.includes(typeof value)) return;
      const expectedMsg = allowed.filter((e) => e).map((e) => e.replace(/^bson:/, '')).join(' or ');
      throw msh.invalidInput(`Argument at position ${i} must be of type ${expectedMsg}, got ${actual.replace(/^bson:/, '')} instead (${func})`);
    });
  }
  msh.assertArgs = assertArgs;

  // ------------------------------------------------------------------
  // ObjectId
  // ------------------------------------------------------------------

  const HEX24 = /^[0-9a-fA-F]{24}$/;
  const OBJECT_ID_INPUT = 'input must be a 24 character hex string, 12 byte Uint8Array, or an integer';

  function ObjectId(inputId) {
    if (!(this instanceof ObjectId)) return new ObjectId(inputId);
    if (inputId !== undefined && !['string', 'number', 'object'].includes(typeof inputId)) {
      throw msh.invalidInput(`Argument at position 0 must be of type string or number or object, got ${typeof inputId} instead (ObjectId)`);
    }
    let workingId = inputId;
    if (typeof inputId === 'object' && inputId && 'id' in inputId) {
      if (typeof inputId.id !== 'string' && !ArrayBuffer.isView(inputId.id)) {
        throw new BSONError('Argument passed in must have an id that is of type string or Buffer');
      }
      workingId = typeof inputId.toHexString === 'function' ? bytes.fromHex(inputId.toHexString()) : inputId.id;
    }
    let buffer;
    if (workingId === undefined || workingId === null) {
      buffer = bytes.fromHex(native.newObjectId());
    } else if (typeof workingId === 'number') {
      buffer = bytes.fromHex((Math.floor(workingId) >>> 0).toString(16).padStart(8, '0') + native.newObjectId().slice(8));
    } else if (ArrayBuffer.isView(workingId) && workingId.byteLength === 12) {
      buffer = Uint8Array.from(workingId);
    } else if (typeof workingId === 'string') {
      if (!HEX24.test(workingId)) throw new BSONError(OBJECT_ID_INPUT);
      buffer = bytes.fromHex(workingId);
    } else {
      throw new BSONError('Argument passed in does not match the accepted types');
    }
    this.buffer = buffer;
  }
  describe(ObjectId, 'ObjectId', function (depth, options) {
    return `ObjectId(${show(this.toHexString(), options)})`;
  });
  Object.defineProperty(ObjectId.prototype, 'id', {
    get() { return this.buffer; },
    enumerable: false,
    configurable: true,
  });
  msh.hide(ObjectId.prototype, {
    toHexString() { return bytes.toHex(this.buffer); },
    toString(encoding) {
      if (encoding === 'base64') return bytes.toBase64(this.buffer);
      return bytes.toHex(this.buffer);
    },
    toJSON() { return bytes.toHex(this.buffer); },
    equals(other) {
      if (other === undefined || other === null) return false;
      const hex = bytes.toHex(this.buffer);
      if (other instanceof ObjectId) return bytes.toHex(other.buffer) === hex;
      if (typeof other === 'string') return other.toLowerCase() === hex;
      if (typeof other === 'object' && typeof other.toHexString === 'function') {
        return String(other.toHexString()).toLowerCase() === hex;
      }
      return false;
    },
    getTimestamp() {
      const b = this.buffer;
      return new Date((((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) * 1000);
    },
    toExtendedJSON() { return { $oid: bytes.toHex(this.buffer) }; },
  });
  ObjectId.createFromTime = (time) => new ObjectId((Math.floor(time) >>> 0).toString(16).padStart(8, '0') + '0000000000000000');
  ObjectId.createFromHexString = (hex) => {
    if (typeof hex !== 'string' || !HEX24.test(hex)) throw new BSONError('hex string must be 24 characters');
    return new ObjectId(hex);
  };
  ObjectId.createFromBase64 = (b64) => new ObjectId(bytes.fromBase64(b64));
  ObjectId.generate = (time) => new ObjectId(time).buffer;
  ObjectId.isValid = (id) => {
    if (id == null) return false;
    try {
      new ObjectId(id);
      return true;
    } catch {
      return false;
    }
  };

  // ------------------------------------------------------------------
  // Long (64-bit integer) and Timestamp
  // ------------------------------------------------------------------

  const MASK64 = (1n << 64n) - 1n;

  function Long(low = 0, high, unsigned) {
    if (!(this instanceof Long)) return new Long(low, high, unsigned);
    let from = null;
    if (typeof low === 'bigint') from = Long.fromBigInt(low, !!high);
    else if (typeof low === 'string') from = Long.fromString(low, !!high);
    // Own properties in the BSON library's order: high, low, unsigned.
    this.high = from ? from.high : high | 0;
    this.low = from ? from.low : low | 0;
    this.unsigned = from ? from.unsigned : !!unsigned;
  }
  describe(Long, 'Long', function (depth, options) {
    return `Long(${show(this.toString(), options)}${this.unsigned ? ', true' : ''})`;
  });
  Object.defineProperty(Long.prototype, '__isLong__', { value: true, enumerable: false });

  const big = (long) => {
    const bits = ((BigInt(long.high) & 0xffffffffn) << 32n) | (BigInt(long.low) & 0xffffffffn);
    return long.unsigned ? bits : BigInt.asIntN(64, bits);
  };
  const fromBig = (value, unsigned) => {
    const bits = value & MASK64;
    return new Long(Number(BigInt.asIntN(32, bits)), Number(BigInt.asIntN(32, bits >> 32n)), unsigned);
  };
  const toLong = (value, unsigned) => Long.fromValue(value, unsigned);

  Long.isLong = (value) => value != null && typeof value === 'object' && value.__isLong__ === true;
  Long.fromBits = (low, high, unsigned) => new Long(low, high, unsigned);
  Long.fromInt = (value, unsigned) => fromBig(BigInt(value | 0), !!unsigned);
  Long.fromNumber = (value, unsigned) => {
    if (Number.isNaN(value)) return unsigned ? Long.UZERO : Long.ZERO;
    if (unsigned) {
      if (value < 0) return Long.UZERO;
      if (value >= 18446744073709551616) return Long.MAX_UNSIGNED_VALUE;
    } else {
      if (value <= -9223372036854775808) return Long.MIN_VALUE;
      if (value + 1 >= 9223372036854775808) return Long.MAX_VALUE;
    }
    return fromBig(BigInt(Math.trunc(value)), !!unsigned);
  };
  Long.fromBigInt = (value, unsigned) => fromBig(BigInt(value), !!unsigned);
  Long.fromString = (str, unsigned, radix) => {
    if (typeof unsigned === 'number') { radix = unsigned; unsigned = false; }
    radix = radix || 10;
    if (radix < 2 || radix > 36) throw new BSONError('radix');
    str = String(str);
    if (str.length === 0) throw new BSONError('empty string');
    if (str === 'NaN' || str === 'Infinity' || str === '+Infinity' || str === '-Infinity') return unsigned ? Long.UZERO : Long.ZERO;
    if (str.indexOf('-') > 0) throw new BSONError('interior hyphen');
    const negative = str[0] === '-';
    const digits = negative || str[0] === '+' ? str.slice(1) : str;
    let value = 0n;
    const base = BigInt(radix);
    for (const ch of digits) {
      const digit = parseInt(ch, radix);
      if (Number.isNaN(digit)) break;
      value = value * base + BigInt(digit);
    }
    return fromBig(negative ? -value : value, !!unsigned);
  };
  Long.fromValue = (value, unsigned) => {
    if (typeof value === 'number') return Long.fromNumber(value, unsigned);
    if (typeof value === 'bigint') return Long.fromBigInt(value, unsigned);
    if (typeof value === 'string') return Long.fromString(value, unsigned);
    return new Long(value.low, value.high, typeof unsigned === 'boolean' ? unsigned : value.unsigned);
  };
  Long.fromBytes = (b, unsigned, le) => (le
    ? new Long(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24), b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24), unsigned)
    : new Long((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7], (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], unsigned));

  const arithmetic = (op) => function (other) {
    return fromBig(op(big(this), big(toLong(other, this.unsigned))), this.unsigned);
  };
  const compareTo = (self, other) => {
    const a = big(self);
    const b = big(toLong(other, self.unsigned));
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const divisor = (self, other) => {
    const d = big(toLong(other, self.unsigned));
    if (d === 0n) throw new BSONError('division by zero');
    return d;
  };

  const longMethods = {
    add: arithmetic((a, b) => a + b),
    subtract: arithmetic((a, b) => a - b),
    multiply: arithmetic((a, b) => a * b),
    divide(other) { return fromBig(big(this) / divisor(this, other), this.unsigned); },
    modulo(other) { return fromBig(big(this) % divisor(this, other), this.unsigned); },
    and: arithmetic((a, b) => a & b),
    or: arithmetic((a, b) => a | b),
    xor: arithmetic((a, b) => a ^ b),
    not() { return new Long(~this.low, ~this.high, this.unsigned); },
    negate() { return fromBig(-big(this), this.unsigned); },
    shiftLeft(n) { return fromBig(big(this) << BigInt(Number(Long.isLong(n) ? n.toInt() : n) & 63), this.unsigned); },
    shiftRight(n) { return fromBig(BigInt.asIntN(64, big(this)) >> BigInt(Number(Long.isLong(n) ? n.toInt() : n) & 63), this.unsigned); },
    shiftRightUnsigned(n) { return fromBig((big(this) & MASK64) >> BigInt(Number(Long.isLong(n) ? n.toInt() : n) & 63), this.unsigned); },
    compare(other) { return compareTo(this, other); },
    equals(other) {
      const o = toLong(other, this.unsigned);
      if (this.unsigned !== o.unsigned && this.high >>> 31 === 1 && o.high >>> 31 === 1) return false;
      return this.high === o.high && this.low === o.low;
    },
    notEquals(other) { return !this.equals(other); },
    greaterThan(other) { return compareTo(this, other) > 0; },
    greaterThanOrEqual(other) { return compareTo(this, other) >= 0; },
    lessThan(other) { return compareTo(this, other) < 0; },
    lessThanOrEqual(other) { return compareTo(this, other) <= 0; },
    isZero() { return this.high === 0 && this.low === 0; },
    isNegative() { return !this.unsigned && this.high < 0; },
    isPositive() { return this.unsigned || this.high >= 0; },
    isOdd() { return (this.low & 1) === 1; },
    isEven() { return (this.low & 1) === 0; },
    getHighBits() { return this.high; },
    getHighBitsUnsigned() { return this.high >>> 0; },
    getLowBits() { return this.low; },
    getLowBitsUnsigned() { return this.low >>> 0; },
    getNumBitsAbs() {
      const abs = big(this) < 0n ? -big(this) : big(this);
      return abs === 0n ? 1 : abs.toString(2).length;
    },
    toInt() { return this.unsigned ? this.low >>> 0 : this.low; },
    toNumber() { return Number(big(this)); },
    toBigInt() { return big(this); },
    toSigned() { return this.unsigned ? new Long(this.low, this.high, false) : this; },
    toUnsigned() { return this.unsigned ? this : new Long(this.low, this.high, true); },
    toBytes(le) {
      const hi = this.high, lo = this.low;
      return le
        ? [lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, lo >>> 24, hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, hi >>> 24]
        : [hi >>> 24, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, lo >>> 24, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
    },
    toBytesLE() { return this.toBytes(true); },
    toBytesBE() { return this.toBytes(false); },
    toString(radix) { return big(this).toString(radix || 10); },
    toExtendedJSON(options) {
      if (options && options.relaxed) return this.toNumber();
      return { $numberLong: this.toString() };
    },
  };
  const longAliases = {
    sub: 'subtract', mul: 'multiply', div: 'divide', mod: 'modulo', rem: 'modulo', neg: 'negate',
    shl: 'shiftLeft', shr: 'shiftRight', shru: 'shiftRightUnsigned', shr_u: 'shiftRightUnsigned',
    comp: 'compare', eq: 'equals', neq: 'notEquals', ne: 'notEquals', gt: 'greaterThan',
    gte: 'greaterThanOrEqual', ge: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual',
    le: 'lessThanOrEqual', eqz: 'isZero',
  };
  for (const [alias, target] of Object.entries(longAliases)) longMethods[alias] = longMethods[target];
  msh.hide(Long.prototype, longMethods);

  Long.ZERO = Long.fromInt(0);
  Long.UZERO = Long.fromInt(0, true);
  Long.ONE = Long.fromInt(1);
  Long.UONE = Long.fromInt(1, true);
  Long.NEG_ONE = Long.fromInt(-1);
  Long.MAX_VALUE = new Long(0xffffffff | 0, 0x7fffffff | 0, false);
  Long.MAX_UNSIGNED_VALUE = new Long(0xffffffff | 0, 0xffffffff | 0, true);
  Long.MIN_VALUE = new Long(0, 0x80000000 | 0, false);
  Long.TWO_PWR_24 = Long.fromInt(1 << 24);

  function Timestamp(low, high) {
    if (!(this instanceof Timestamp)) return new Timestamp(low, high);
    let t = 0, i = 0;
    if (low === undefined || low === null) {
      // zero timestamp
    } else if (typeof low === 'bigint') {
      i = Number(BigInt.asUintN(32, low));
      t = Number(BigInt.asUintN(32, low >> 32n));
    } else if (Long.isLong(low)) {
      i = low.low; t = low.high;
    } else if (typeof low === 'object' && 't' in low && 'i' in low) {
      const tv = Number(low.t), iv = Number(low.i);
      if (typeof low.t !== 'number' && !(low.t && low.t._bsontype === 'Int32')) throw new BSONError('Timestamp constructed from { t, i } must provide t as a number');
      if (typeof low.i !== 'number' && !(low.i && low.i._bsontype === 'Int32')) throw new BSONError('Timestamp constructed from { t, i } must provide i as a number');
      if (tv < 0 || Number.isNaN(tv)) throw new BSONError('Timestamp constructed from { t, i } must provide a positive t');
      if (iv < 0 || Number.isNaN(iv)) throw new BSONError('Timestamp constructed from { t, i } must provide a positive i');
      if (tv > 0xffffffff) throw new BSONError('Timestamp constructed from { t, i } must provide t equal or less than uint32 max');
      if (iv > 0xffffffff) throw new BSONError('Timestamp constructed from { t, i } must provide i equal or less than uint32 max');
      t = tv; i = iv;
    } else {
      throw new BSONError('A Timestamp can only be constructed with: bigint, Long, or { t: number; i: number }');
    }
    this.high = t | 0;
    this.low = i | 0;
    this.unsigned = true;
  }
  Timestamp.prototype = Object.create(Long.prototype, {
    constructor: { value: Timestamp, enumerable: false, writable: true, configurable: true },
  });
  describe(Timestamp, 'Timestamp', function (depth, options) {
    return `Timestamp({ t: ${show(this.high >>> 0, options)}, i: ${show(this.low >>> 0, options)} })`;
  });
  Object.defineProperty(Timestamp.prototype, 't', { get() { return this.high >>> 0; }, enumerable: false, configurable: true });
  Object.defineProperty(Timestamp.prototype, 'i', { get() { return this.low >>> 0; }, enumerable: false, configurable: true });
  msh.hide(Timestamp.prototype, {
    toJSON() { return { $timestamp: this.toString() }; },
    toExtendedJSON() { return { $timestamp: { t: this.high >>> 0, i: this.low >>> 0 } }; },
  });
  Timestamp.fromBits = (lowBits, highBits) => new Timestamp({ i: lowBits >>> 0, t: highBits >>> 0 });
  Timestamp.fromInt = (value) => new Timestamp(Long.fromInt(value, true));
  Timestamp.fromNumber = (value) => new Timestamp(Long.fromNumber(value, true));
  Timestamp.fromString = (str, radix) => new Timestamp(Long.fromString(str, true, radix));
  Timestamp.MAX_VALUE = Long.MAX_UNSIGNED_VALUE;

  // ------------------------------------------------------------------
  // Int32, Double, Decimal128
  // ------------------------------------------------------------------

  function Int32(value) {
    if (!(this instanceof Int32)) return new Int32(value);
    if (value instanceof Number) value = value.valueOf();
    this.value = +value | 0;
  }
  describe(Int32, 'Int32', function (depth, options) {
    return `Int32(${show(this.value, options)})`;
  });
  msh.hide(Int32.prototype, {
    valueOf() { return this.value; },
    toString(radix) { return this.value.toString(radix); },
    toJSON() { return this.value; },
    toExtendedJSON(options) {
      if (options && (options.relaxed || options.legacy)) return this.value;
      return { $numberInt: this.value.toString() };
    },
  });
  Int32.fromString = (text) => {
    const trimmed = String(text).trim();
    if (!/^[+-]?\d+$/.test(trimmed)) throw new BSONError(`Input: '${text}' is not a valid Int32 string`);
    const value = Number(trimmed);
    if (value < -2147483648 || value > 2147483647) throw new BSONError(`Input: '${text}' is smaller than the minimum value for Int32 or larger than the maximum`);
    return new Int32(value);
  };

  function Double(value) {
    if (!(this instanceof Double)) return new Double(value);
    if (value instanceof Number) value = value.valueOf();
    this.value = +value;
  }
  describe(Double, 'Double', function (depth, options) {
    return `Double(${show(this.value, options)})`;
  });
  msh.hide(Double.prototype, {
    valueOf() { return this.value; },
    toString(radix) { return this.value.toString(radix); },
    toJSON() { return this.value; },
    toExtendedJSON(options) {
      if (options && (options.legacy || (options.relaxed && Number.isFinite(this.value)))) return this.value;
      if (Object.is(Math.sign(this.value), -0)) return { $numberDouble: '-0.0' };
      return { $numberDouble: Number.isInteger(this.value) ? this.value.toFixed(1) : this.value.toString() };
    },
  });
  Double.fromString = (text) => {
    const value = Number(String(text).trim());
    if (String(text).trim() === '' || Number.isNaN(value) && String(text).trim() !== 'NaN') throw new BSONError(`Input: '${text}' is not a valid Double string`);
    return new Double(value);
  };

  function Decimal128(input) {
    if (!(this instanceof Decimal128)) return new Decimal128(input);
    if (typeof input === 'string') {
      this.bytes = Decimal128.fromString(input).bytes;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength !== 16) throw new BSONError('Decimal128 must take a Buffer of 16 bytes');
      this.bytes = input;
    } else {
      throw new BSONError('Decimal128 must take a Buffer or string');
    }
  }
  describe(Decimal128, 'Decimal128', function (depth, options) {
    return `Decimal128(${show(this.toString(), options)})`;
  });
  msh.hide(Decimal128.prototype, {
    toString() { return native.decimalToString(this.bytes); },
    toJSON() { return { $numberDecimal: this.toString() }; },
    toExtendedJSON() { return { $numberDecimal: this.toString() }; },
  });
  Decimal128.fromString = (text) => {
    const parsed = native.decimalFromString(String(text));
    if (parsed === null) throw new BSONError(`${text} not a valid Decimal128 string`);
    return new Decimal128(parsed);
  };
  Decimal128.fromStringWithRounding = Decimal128.fromString;

  // ------------------------------------------------------------------
  // Binary and UUID
  // ------------------------------------------------------------------

  const UUID_INPUT = 'Argument passed in UUID constructor must be a UUID, a 16 byte Buffer or a 32/36 character hex string (dashes excluded/included, format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
  const UUID_WITH_DASHES = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  const UUID_WITHOUT_DASHES = /^[0-9A-F]{32}$/i;
  const dashed = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

  function toBuffer(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Array.isArray(input)) return Uint8Array.from(input);
    throw new BSONError('Binary can only be constructed from Uint8Array or number[]');
  }

  function Binary(buffer, subType) {
    if (!(this instanceof Binary)) return new Binary(buffer, subType);
    // Own properties in the BSON library's order: buffer, sub_type, position.
    const empty = buffer === undefined || buffer === null;
    this.buffer = empty ? new Uint8Array(Binary.BUFFER_SIZE) : toBuffer(buffer);
    this.sub_type = subType === undefined || subType === null ? Binary.BSON_BINARY_SUBTYPE_DEFAULT : subType;
    this.position = empty ? 0 : this.buffer.byteLength;
  }
  Object.assign(Binary, {
    BSON_BINARY_SUBTYPE_DEFAULT: 0, BUFFER_SIZE: 256, SUBTYPE_DEFAULT: 0, SUBTYPE_FUNCTION: 1,
    SUBTYPE_BYTE_ARRAY: 2, SUBTYPE_UUID_OLD: 3, SUBTYPE_UUID: 4, SUBTYPE_MD5: 5, SUBTYPE_ENCRYPTED: 6,
    SUBTYPE_COLUMN: 7, SUBTYPE_SENSITIVE: 8, SUBTYPE_VECTOR: 9, SUBTYPE_USER_DEFINED: 128,
    VECTOR_TYPE: Object.freeze({ Int8: 0x03, Float32: 0x27, PackedBit: 0x10 }),
  });

  function printBinary(depth, options) {
    const data = this.buffer.subarray(0, this.position);
    switch (this.sub_type) {
      case Binary.SUBTYPE_VECTOR: {
        const items = (list) => msh.inspect(Array.from(list), { maxArrayLength: Infinity, breakLength: Infinity });
        try {
          if (data[0] === Binary.VECTOR_TYPE.Int8) return `Binary.fromInt8Array(new Int8Array(${items(this.toInt8Array())}))`;
          if (data[0] === Binary.VECTOR_TYPE.Float32) return `Binary.fromFloat32Array(new Float32Array(${items(this.toFloat32Array())}))`;
          if (data[0] === Binary.VECTOR_TYPE.PackedBit) return `Binary.fromPackedBits(new Uint8Array(${items(this.toPackedBits())}), ${data[1]})`;
        } catch { /* malformed vector: print the raw bytes */ }
        break;
      }
      case Binary.SUBTYPE_MD5:
        return `MD5(${show(bytes.toHex(data), options)})`;
      case Binary.SUBTYPE_UUID:
        if (data.length === 16) return `UUID(${show(dashed(bytes.toHex(data)), options)})`;
        break;
      default:
    }
    return `Binary.createFromBase64(${show(bytes.toBase64(data), options)}, ${show(this.sub_type, options)})`;
  }
  describe(Binary, 'Binary', printBinary);

  msh.hide(Binary.prototype, {
    put(byteValue) {
      let value = byteValue;
      if (typeof value === 'string') {
        if (value.length !== 1) throw new BSONError('only accepts single character String');
        value = value.charCodeAt(0);
      } else if (typeof value !== 'number') {
        if (value.length !== 1) throw new BSONError('only accepts single character Uint8Array or Array');
        value = value[0];
      }
      if (value < 0 || value > 255) throw new BSONError('only accepts number in a valid unsigned byte range 0-255');
      if (this.buffer.byteLength <= this.position) {
        const grown = new Uint8Array(Binary.BUFFER_SIZE + this.buffer.length);
        grown.set(this.buffer, 0);
        this.buffer = grown;
      }
      this.buffer[this.position++] = value;
    },
    write(sequence, offset) {
      offset = typeof offset === 'number' ? offset : this.position;
      const data = typeof sequence === 'string' ? bytes.fromLatin1(sequence) : toBuffer(sequence);
      if (this.buffer.byteLength < offset + data.length) {
        const grown = new Uint8Array(this.buffer.byteLength + data.length);
        grown.set(this.buffer, 0);
        this.buffer = grown;
      }
      this.buffer.set(data, offset);
      this.position = offset + data.length > this.position ? offset + data.length : this.position;
    },
    read(position, length) {
      length = length && length > 0 ? length : this.position;
      const end = position + length;
      return this.buffer.subarray(position, end > this.position ? this.position : end);
    },
    value() {
      return this.buffer.length === this.position ? this.buffer : this.buffer.subarray(0, this.position);
    },
    length() { return this.position; },
    toJSON() { return bytes.toBase64(this.buffer.subarray(0, this.position)); },
    toString(encoding) {
      const data = this.buffer.subarray(0, this.position);
      if (encoding === 'hex') return bytes.toHex(data);
      if (encoding === 'base64') return bytes.toBase64(data);
      return bytes.toUtf8(data);
    },
    toUUID() {
      if (this.sub_type === Binary.SUBTYPE_UUID) return new UUID(this.buffer.subarray(0, this.position));
      throw new BSONError(`Binary sub_type "${this.sub_type}" is not supported for converting to UUID. Only "${Binary.SUBTYPE_UUID}" is currently supported.`);
    },
    toExtendedJSON(options) {
      const base64 = bytes.toBase64(this.buffer.subarray(0, this.position));
      const subType = Number(this.sub_type).toString(16).padStart(2, '0');
      if (options && options.legacy) return { $binary: base64, $type: subType };
      return { $binary: { base64, subType } };
    },
    toInt8Array() {
      const data = this.buffer.subarray(0, this.position);
      if (this.sub_type !== Binary.SUBTYPE_VECTOR) throw new BSONError('Binary sub_type is not Vector');
      if (data[0] !== Binary.VECTOR_TYPE.Int8) throw new BSONError('Binary datatype field is not Int8');
      return new Int8Array(data.slice(2).buffer);
    },
    toFloat32Array() {
      const data = this.buffer.subarray(0, this.position);
      if (this.sub_type !== Binary.SUBTYPE_VECTOR) throw new BSONError('Binary sub_type is not Vector');
      if (data[0] !== Binary.VECTOR_TYPE.Float32) throw new BSONError('Binary datatype field is not Float32');
      return new Float32Array(data.slice(2).buffer);
    },
    toPackedBits() {
      const data = this.buffer.subarray(0, this.position);
      if (this.sub_type !== Binary.SUBTYPE_VECTOR) throw new BSONError('Binary sub_type is not Vector');
      if (data[0] !== Binary.VECTOR_TYPE.PackedBit) throw new BSONError('Binary datatype field is not packed bit');
      return data.slice(2);
    },
    toBits() {
      const packed = this.toPackedBits();
      const padding = this.buffer[1];
      const bits = new Int8Array(packed.length * 8 - padding);
      for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
      return bits;
    },
  });
  Binary.createFromHexString = (hex, subType) => new Binary(bytes.fromHex(hex), subType);
  Binary.createFromBase64 = (base64, subType) => new Binary(bytes.fromBase64(base64), subType);
  const vector = (dtype, padding, payload) => {
    const out = new Uint8Array(payload.byteLength + 2);
    out[0] = dtype;
    out[1] = padding;
    out.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), 2);
    return new Binary(out, Binary.SUBTYPE_VECTOR);
  };
  Binary.fromInt8Array = (array) => vector(Binary.VECTOR_TYPE.Int8, 0, array);
  Binary.fromFloat32Array = (array) => vector(Binary.VECTOR_TYPE.Float32, 0, array);
  Binary.fromPackedBits = (array, padding = 0) => vector(Binary.VECTOR_TYPE.PackedBit, padding, array);
  Binary.fromBits = (bits) => {
    const packed = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== 0 && bits[i] !== 1) throw new BSONError(`Invalid bit value at ${i}: must be 0 or 1, found ${bits[i]}`);
      packed[i >> 3] |= bits[i] << (7 - (i & 7));
    }
    return vector(Binary.VECTOR_TYPE.PackedBit, packed.length * 8 - bits.length, packed);
  };

  function UUID(input) {
    if (!(this instanceof UUID)) return new UUID(input);
    let data;
    if (input === undefined || input === null) {
      data = UUID.generate();
    } else if (input instanceof UUID) {
      data = Uint8Array.from(input.buffer);
    } else if (input instanceof Uint8Array && input.byteLength === 16) {
      data = Uint8Array.from(input);
    } else if (typeof input === 'string' && (UUID_WITH_DASHES.test(input) || UUID_WITHOUT_DASHES.test(input))) {
      data = bytes.fromHex(input.replace(/-/g, ''));
    } else {
      throw new BSONError(UUID_INPUT);
    }
    this.buffer = data;
    this.sub_type = Binary.SUBTYPE_UUID;
    this.position = 16;
  }
  UUID.prototype = Object.create(Binary.prototype, {
    constructor: { value: UUID, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(UUID.prototype, 'id', {
    get() { return this.buffer; },
    set(value) { this.buffer = value; },
    enumerable: false,
    configurable: true,
  });
  msh.hide(UUID.prototype, {
    toHexString(includeDashes = true) {
      const hex = bytes.toHex(this.buffer);
      return includeDashes ? dashed(hex) : hex;
    },
    toString(encoding) {
      if (encoding === 'hex') return bytes.toHex(this.buffer);
      if (encoding === 'base64') return bytes.toBase64(this.buffer);
      return this.toHexString();
    },
    toJSON() { return this.toHexString(); },
    equals(other) {
      if (!other) return false;
      if (other instanceof UUID) return bytes.toHex(other.buffer) === bytes.toHex(this.buffer);
      try {
        return bytes.toHex(new UUID(other).buffer) === bytes.toHex(this.buffer);
      } catch {
        return false;
      }
    },
    toBinary() { return new Binary(this.buffer, Binary.SUBTYPE_UUID); },
  });
  UUID.generate = () => native.newUuid();
  UUID.isValid = (input) => {
    if (!input) return false;
    if (typeof input === 'string') return UUID_WITH_DASHES.test(input) || UUID_WITHOUT_DASHES.test(input);
    if (input instanceof Uint8Array) return input.byteLength === 16;
    return input._bsontype === 'Binary' && input.sub_type === Binary.SUBTYPE_UUID && input.buffer.byteLength === 16;
  };
  UUID.createFromHexString = (hex) => new UUID(bytes.fromHex(String(hex).replace(/-/g, '')));
  UUID.createFromBase64 = (base64) => new UUID(bytes.fromBase64(base64));

  // ------------------------------------------------------------------
  // MinKey, MaxKey, BSONRegExp, BSONSymbol, Code, DBRef
  // ------------------------------------------------------------------

  function MinKey() {
    if (!(this instanceof MinKey)) return new MinKey();
  }
  describe(MinKey, 'MinKey', () => 'MinKey()');
  msh.hide(MinKey.prototype, { toExtendedJSON: () => ({ $minKey: 1 }) });
  // `{ a: MinKey }` (without the call) is accepted too.
  MinKey.toBSON = () => new MinKey();

  function MaxKey() {
    if (!(this instanceof MaxKey)) return new MaxKey();
  }
  describe(MaxKey, 'MaxKey', () => 'MaxKey()');
  msh.hide(MaxKey.prototype, { toExtendedJSON: () => ({ $maxKey: 1 }) });
  MaxKey.toBSON = () => new MaxKey();

  function BSONRegExp(pattern, options) {
    if (!(this instanceof BSONRegExp)) return new BSONRegExp(pattern, options);
    this.pattern = pattern;
    this.options = String(options === undefined || options === null ? '' : options).split('').sort().join('');
    if (String(this.pattern).indexOf('\x00') !== -1) {
      throw new BSONError(`BSON Regex patterns cannot contain null bytes, found: ${JSON.stringify(this.pattern)}`);
    }
    if (this.options.indexOf('\x00') !== -1) {
      throw new BSONError(`BSON Regex options cannot contain null bytes, found: ${JSON.stringify(this.options)}`);
    }
    for (const ch of this.options) {
      if (!'imxlsu'.includes(ch)) throw new BSONError(`The regular expression option [${ch}] is not supported`);
    }
  }
  describe(BSONRegExp, 'BSONRegExp', function (depth, options) {
    return `BSONRegExp(${show(String(this.pattern), options)}, ${show(String(this.options), options)})`;
  });
  msh.hide(BSONRegExp.prototype, {
    toExtendedJSON(options) {
      if (options && options.legacy) return { $regex: this.pattern, $options: this.options };
      return { $regularExpression: { pattern: this.pattern, options: this.options } };
    },
  });

  function BSONSymbol(value) {
    if (!(this instanceof BSONSymbol)) return new BSONSymbol(value);
    this.value = value;
  }
  describe(BSONSymbol, 'BSONSymbol', function (depth, options) {
    return `BSONSymbol(${show(this.value, options)})`;
  });
  msh.hide(BSONSymbol.prototype, {
    valueOf() { return this.value; },
    toString() { return this.value; },
    toJSON() { return this.value; },
    toExtendedJSON() { return { $symbol: this.value }; },
  });

  function Code(code = '', scope) {
    if (!(this instanceof Code)) return new Code(code, scope);
    assertArgs([code, scope], [[undefined, 'string', 'function'], [undefined, 'object']], 'Code');
    this.code = code.toString();
    this.scope = scope === undefined ? null : scope;
  }
  describe(Code, 'Code', function (depth, options) {
    return `Code(${show(String(this.code), options)}${this.scope != null ? `, ${show(this.scope, options)}` : ''})`;
  });
  msh.hide(Code.prototype, {
    toJSON() {
      return this.scope != null ? { code: this.code, scope: this.scope } : { code: this.code };
    },
    toExtendedJSON() {
      return this.scope ? { $code: this.code, $scope: this.scope } : { $code: this.code };
    },
  });

  function DBRef(collection, oid, db, fields) {
    if (!(this instanceof DBRef)) return new DBRef(collection, oid, db, fields);
    assertArgs([collection, oid, db, fields], [['string'], true, [undefined, 'string'], [undefined, 'object']], 'DBRef');
    // Compatibility with the "db.collection" single-string form.
    const parts = String(collection).split('.');
    if (parts.length === 2) {
      db = parts.shift();
      collection = parts.shift();
    }
    this.collection = collection;
    this.oid = oid;
    this.db = db;
    this.fields = fields || {};
  }
  describe(DBRef, 'DBRef', function (depth, options) {
    const parts = [show(String(this.collection), options), show(this.oid, options)];
    if (this.db) parts.push(show(String(this.db), options));
    if (this.fields && Object.keys(this.fields).length) parts.push(show(this.fields, options));
    return `DBRef(${parts.join(', ')})`;
  });
  Object.defineProperty(DBRef.prototype, 'namespace', {
    get() { return this.collection; },
    set(value) { this.collection = value; },
    enumerable: false,
    configurable: true,
  });
  msh.hide(DBRef.prototype, {
    toJSON() {
      const out = Object.assign({ $ref: this.collection, $id: this.oid }, this.fields);
      if (this.db != null) out.$db = this.db;
      return out;
    },
    toExtendedJSON() {
      let out = { $ref: this.collection, $id: this.oid };
      if (this.db) out.$db = this.db;
      out = Object.assign(out, this.fields);
      return out;
    },
  });

  // ------------------------------------------------------------------
  // Values coming back from the server (see convert.rs for the tags)
  // ------------------------------------------------------------------

  const objectIdFromBytes = (buffer) => {
    const oid = Object.create(ObjectId.prototype);
    oid.buffer = buffer;
    return oid;
  };

  msh.fromBson = function (tag, a, b) {
    switch (tag) {
      case 1: return objectIdFromBytes(a);
      case 2: return new Long(a, b, false);
      case 3: return new Decimal128(a);
      case 4: return new Timestamp({ t: a, i: b });
      case 5: return b === Binary.SUBTYPE_UUID && a.length === 16 ? new UUID(a) : new Binary(a, b);
      case 6: return new MinKey();
      case 7: return new MaxKey();
      case 8: {
        // Same flag mapping as the Node driver: BSON `s` becomes JS `g`.
        let flags = '';
        for (const ch of b) flags += ch === 's' ? 'g' : ch === 'i' || ch === 'm' ? ch : '';
        try {
          return new RegExp(a, flags);
        } catch {
          return new BSONRegExp(a, b);
        }
      }
      case 9: return new Code(a, b);
      case 11: return new DBRef(a, objectIdFromBytes(b));
      case 12: return new Date(a);
      case 14: {
        const { $ref, $id, $db, ...fields } = a;
        return new DBRef($ref, $id, $db, fields);
      }
      default: throw new BSONError(`unknown BSON tag ${tag}`);
    }
  };

  // ------------------------------------------------------------------
  // Shell constructors
  // ------------------------------------------------------------------


  const NUMBER_WARNING = (name) => `Warning: ${name}: specifying a number as argument is deprecated and may lead to loss of precision, pass a string instead`;

  function NumberLong(s = '0') {
    if (s === null) s = '0';
    assertArgs([s], [['string', 'number', 'bson:Long', 'bson:Int32']], 'NumberLong');
    if (typeof s === 'number') {
      msh.println(NUMBER_WARNING('NumberLong'));
      return Long.fromNumber(s);
    }
    if (typeof s === 'object') return Long.fromString(s.toString());
    return Long.fromString(s);
  }
  NumberLong.prototype = Long.prototype;

  function NumberInt(v = '0') {
    if (v === null) v = '0';
    assertArgs([v], [['string', 'number', 'bson:Long', 'bson:Int32']], 'NumberInt');
    return new Int32(parseInt(`${v}`, 10));
  }
  NumberInt.prototype = Int32.prototype;

  function NumberDecimal(s = '0') {
    assertArgs([s], [['string', 'number', 'bson:Long', 'bson:Int32', 'bson:Decimal128']], 'NumberDecimal');
    if (typeof s === 'number') {
      msh.println(NUMBER_WARNING('NumberDecimal'));
      return Decimal128.fromString(`${s}`);
    }
    if (typeof s === 'object') return Decimal128.fromString(s.toString());
    return Decimal128.fromString(s);
  }
  NumberDecimal.prototype = Decimal128.prototype;

  function ShellTimestamp(t, i) {
    assertArgs([t, i], [['number', 'object', null], [null, 'number']], 'Timestamp');
    // The shell takes (seconds, increment); the driver class takes them the
    // other way around.
    if (typeof t === 'object' && t !== null && 't' in t && 'i' in t) return new Timestamp({ t: t.t, i: t.i });
    if (t !== null && typeof t === 'object') return new Timestamp(t);
    return new Timestamp({ t: t === undefined || t === null ? 0 : t, i: i === undefined || i === null ? 0 : i });
  }
  ShellTimestamp.prototype = Timestamp.prototype;
  for (const key of ['fromBits', 'fromInt', 'fromNumber', 'fromString', 'MAX_VALUE']) ShellTimestamp[key] = Timestamp[key];
  Object.defineProperty(ShellTimestamp, 'name', { value: 'Timestamp' });

  const ISO_DATE = /^(?<Y>\d{4})-?(?<M>\d{2})-?(?<D>\d{2})([T ](?<h>\d{2})(:?(?<m>\d{2})(:?((?<s>\d{2})(\.(?<ms>\d+))?))?)?(?<tz>Z|([+-])(\d{2}):?(\d{2})?)?)?$/;

  function ISODate(input) {
    if (input === undefined) return new Date();
    if (typeof input !== 'string') return new Date(input);
    const match = input.match(ISO_DATE);
    if (match !== null) {
      const { Y, M, D, h, m, s, ms, tz } = match.groups;
      const month = Number(M), day = Number(D), hour = Number(h || 0), minute = Number(m || 0), second = Number(s || 0);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 24 && minute <= 59 && second <= 59) {
        const millis = Number((ms || '0').padEnd(3, '0').slice(0, 3));
        const date = new Date(0);
        date.setUTCFullYear(Number(Y), month - 1, day);
        date.setUTCHours(hour, minute, second, millis);
        let time = date.getTime();
        if (tz && tz !== 'Z') {
          // An offset needs minutes (+05:30 or +0530); "+05" is not a date.
          const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
          if (offset === null) time = NaN;
          else time += (offset[1] === '-' ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60000;
        }
        // 0000-01-01T00:00:00.000Z through 9999-12-31T23:59:59.999Z
        if (time >= -62167219200000 && time <= 253402300799999) return new Date(time);
      }
    }
    throw new msh.errors.MongoshInvalidInputError(`${JSON.stringify(input)} is not a valid ISODate`, 'COMMON-10001');
  }

  // The shell's UUID() builds a subtype-4 Binary; values read back from the
  // server are instances of the UUID class. Both print as UUID('...').
  function ShellUUID(hexstr) {
    if (hexstr === undefined) return new Binary(UUID.generate(), Binary.SUBTYPE_UUID);
    assertArgs([hexstr], [['string']], 'UUID');
    return new Binary(bytes.fromHex(hexstr.replace(/-/g, '')), Binary.SUBTYPE_UUID);
  }
  ShellUUID.prototype = UUID.prototype;
  for (const key of ['generate', 'isValid', 'createFromHexString', 'createFromBase64']) ShellUUID[key] = UUID[key];
  Object.defineProperty(ShellUUID, 'name', { value: 'UUID' });

  function MD5(hexstr) {
    assertArgs([hexstr], [['string']], 'MD5');
    return new Binary(bytes.fromHex(hexstr), Binary.SUBTYPE_MD5);
  }
  function HexData(subtype, hexstr) {
    assertArgs([subtype, hexstr], [['number'], ['string']], 'HexData');
    return new Binary(bytes.fromHex(hexstr), subtype);
  }
  function BinData(subtype, b64string) {
    assertArgs([subtype, b64string], [['number'], ['string']], 'BinData');
    return new Binary(bytes.fromBase64(b64string), subtype);
  }

  // The legacy UUID encodings differ only in byte order.
  const swap = (hex, order) => order.map((i) => hex.substr(i * 2, 2)).join('');
  function legacyUuid(name, order) {
    return function (hexstr) {
      if (hexstr === undefined) hexstr = bytes.toHex(UUID.generate());
      assertArgs([hexstr], [['string']], name);
      const hex = hexstr.replace(/[{}-]/g, '');
      return new Binary(bytes.fromHex(order ? swap(hex, order) : hex), Binary.SUBTYPE_UUID_OLD);
    };
  }
  const LegacyJavaUUID = legacyUuid('LegacyJavaUUID', [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8]);
  const LegacyCSharpUUID = legacyUuid('LegacyCSharpUUID', [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
  const LegacyPythonUUID = legacyUuid('LegacyPythonUUID', null);

  function bsonsize(object) {
    assertArgs([object], [['object']], 'bsonsize');
    return native.bsonSize(object);
  }

  msh.bsonError = (message) => new BSONError(message);

  msh.bson = {
    BSONError, ObjectId, Long, Timestamp, Int32, Double, Decimal128, Binary, UUID, MinKey, MaxKey,
    BSONRegExp, BSONSymbol, Code, DBRef,
  };
  // help.js loads later; it gives each class its help() from this list.
  msh.bsonClasses = {
    ObjectId, Long, Timestamp, Int32, Double, Decimal128, Binary, UUID, MinKey, MaxKey, BSONRegExp, BSONSymbol, Code, DBRef,
  };
  // Shell-only constructors that return one of the classes above.
  msh.bsonAliases = {
    NumberLong: 'Long', NumberInt: 'Int32', NumberDecimal: 'Decimal128', Timestamp: 'Timestamp', UUID: 'Binary',
    MD5: 'Binary', HexData: 'Binary', BinData: 'Binary',
  };

  Object.assign(g, {
    ObjectId, Long, Int32, Double, Decimal128, Binary, MinKey, MaxKey, BSONRegExp, BSONSymbol, Code, DBRef,
    Timestamp: ShellTimestamp, UUID: ShellUUID, NumberLong, NumberInt, NumberDecimal, ISODate,
    MD5, HexData, BinData, LegacyJavaUUID, LegacyCSharpUUID, LegacyPythonUUID, bsonsize,
  });
})(globalThis);
