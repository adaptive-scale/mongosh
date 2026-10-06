// MongoDB Extended JSON (the `EJSON` global), following the BSON library's
// canonical and relaxed formats.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const {
    BSONError, ObjectId, Long, Timestamp, Int32, Double, Decimal128, Binary, UUID, MinKey, MaxKey,
    BSONRegExp, BSONSymbol, Code, DBRef,
  } = msh.bson;
  const bytes = msh.bytes;

  const INT32_MAX = 0x7fffffff;
  const INT32_MIN = -0x80000000;
  const INT64_MAX = 0x8000000000000000;
  const INT64_MIN = -0x8000000000000000;

  function isDBRefLike(value) {
    return value != null && typeof value === 'object' && '$id' in value && value.$id != null &&
      '$ref' in value && typeof value.$ref === 'string' &&
      (!('$db' in value) || ('$db' in value && typeof value.$db === 'string'));
  }

  // ------------------------------------------------------------------
  // serialize: JS values -> Extended JSON objects
  // ------------------------------------------------------------------

  function serializeValue(value, options, seen) {
    if (Array.isArray(value)) {
      if (seen.includes(value)) throw new BSONError('Converting circular structure to EJSON');
      seen.push(value);
      const out = value.map((item) => serializeValue(item, options, seen));
      seen.pop();
      return out;
    }
    if (value === undefined) return null;
    if (value instanceof Date) {
      const time = value.getTime();
      // Relaxed dates are ISO strings while they fit in 1970-9999.
      const inRange = time > -1 && time < 253402318800000;
      // Whole seconds are written without the ".000" fraction.
      const iso = value.getUTCMilliseconds() !== 0 ? value.toISOString() : `${value.toISOString().slice(0, -5)}Z`;
      if (options.legacy) return options.relaxed && inRange ? { $date: time } : { $date: iso };
      return options.relaxed && inRange ? { $date: iso } : { $date: { $numberLong: time.toString() } };
    }
    if (typeof value === 'number' && (!options.relaxed || !Number.isFinite(value))) {
      if (Number.isInteger(value) && !Object.is(value, -0)) {
        if (value >= INT32_MIN && value <= INT32_MAX) return { $numberInt: value.toString() };
        if (value >= INT64_MIN && value <= INT64_MAX) return { $numberLong: value.toString() };
      }
      return { $numberDouble: Object.is(value, -0) ? '-0.0' : value.toString() };
    }
    if (typeof value === 'bigint') {
      if (!options.relaxed) return { $numberLong: BigInt.asIntN(64, value).toString() };
      return Number(BigInt.asIntN(64, value));
    }
    if (value instanceof RegExp) {
      const flags = value.flags.split('').sort().join('');
      return new BSONRegExp(value.source, flags.replace(/[^imxlsu]/g, '')).toExtendedJSON(options);
    }
    if (value != null && typeof value === 'object') return serializeDocument(value, options, seen);
    return value;
  }

  function serializeDocument(doc, options, seen) {
    if (doc == null || typeof doc !== 'object') throw new BSONError('not an object instance');
    if (typeof doc._bsontype === 'string' && typeof doc.toExtendedJSON === 'function') {
      if (doc._bsontype === 'Code' && doc.scope) {
        return { $code: doc.code, $scope: serializeValue(doc.scope, options, seen) };
      }
      if (doc._bsontype === 'DBRef') {
        const out = { $ref: doc.collection, $id: serializeValue(doc.oid, options, seen) };
        if (doc.db) out.$db = doc.db;
        for (const key of Object.keys(doc.fields || {})) out[key] = serializeValue(doc.fields[key], options, seen);
        return out;
      }
      return doc.toExtendedJSON(options);
    }
    if (seen.includes(doc)) throw new BSONError('Converting circular structure to EJSON');
    seen.push(doc);
    const out = {};
    for (const name of Object.keys(doc)) {
      const value = serializeValue(doc[name], options, seen);
      if (name === '__proto__') {
        Object.defineProperty(out, name, { value, writable: true, enumerable: true, configurable: true });
      } else {
        out[name] = value;
      }
    }
    seen.pop();
    return out;
  }

  function serialize(value, options) {
    return serializeValue(value, Object.assign({ relaxed: true, legacy: false }, options), []);
  }

  // ------------------------------------------------------------------
  // deserialize: Extended JSON objects -> JS values
  // ------------------------------------------------------------------

  function parseDate(d, options) {
    if (typeof d === 'number') return new Date(d);
    if (typeof d === 'string') {
      const date = new Date(d);
      if (Number.isNaN(date.getTime())) throw new BSONError(`Unable to parse \`${d}\` as a Date`);
      return date;
    }
    if (Long.isLong(d)) return new Date(d.toNumber());
    if (d && typeof d === 'object' && '$numberLong' in d) return new Date(Number(d.$numberLong));
    if (typeof d === 'bigint') return new Date(Number(d));
    throw new BSONError(`Unrecognized type for EJSON date: ${typeof d}`);
  }

  const keysToCodecs = {
    $oid: (v) => new ObjectId(v.$oid),
    $binary: (v) => {
      if (typeof v.$binary === 'string') return Binary.createFromBase64(v.$binary, v.$type ? parseInt(v.$type, 16) : 0);
      return Binary.createFromBase64(v.$binary.base64, v.$binary.subType ? parseInt(v.$binary.subType, 16) : 0);
    },
    $uuid: (v) => new UUID(v.$uuid).toBinary(),
    $numberDecimal: (v) => Decimal128.fromString(v.$numberDecimal),
    $numberDouble: (v, options) => {
      if (options.relaxed || options.legacy) return parseFloat(v.$numberDouble);
      return new Double(parseFloat(v.$numberDouble));
    },
    $numberInt: (v, options) => {
      if (options.relaxed || options.legacy) return parseInt(v.$numberInt, 10);
      return new Int32(v.$numberInt);
    },
    $numberLong: (v, options) => {
      const long = Long.fromString(v.$numberLong);
      if (options.useBigInt64) return long.toBigInt();
      return options.relaxed ? long.toNumber() : long;
    },
    $minKey: () => new MinKey(),
    $maxKey: () => new MaxKey(),
    $regex: (v) => new BSONRegExp(v.$regex, BSONRegExp.parseOptions ? BSONRegExp.parseOptions(v.$options) : v.$options),
    $regularExpression: (v) => new BSONRegExp(v.$regularExpression.pattern, v.$regularExpression.options),
    $symbol: (v) => new BSONSymbol(v.$symbol),
    $timestamp: (v) => new Timestamp({ t: v.$timestamp.t, i: v.$timestamp.i }),
  };

  function deserializeValue(value, options) {
    if (typeof value === 'number') {
      if (options.relaxed || options.legacy) return value;
      if (Number.isInteger(value) && !Object.is(value, -0)) {
        if (value >= INT32_MIN && value <= INT32_MAX) return new Int32(value);
        if (value >= INT64_MIN && value <= INT64_MAX) return Long.fromNumber(value);
      }
      return new Double(value);
    }
    if (value == null || typeof value !== 'object') return value;
    if (value.$undefined) return null;

    const keys = Object.keys(value).filter((k) => k.startsWith('$') && value[k] != null);
    for (const key of keys) {
      const codec = keysToCodecs[key];
      if (codec) return codec(value, options);
    }
    if (value.$date != null) return parseDate(value.$date, options);
    if (value.$code != null) {
      const copy = Object.assign({}, value);
      if (value.$scope) copy.$scope = deserializeValue(value.$scope, options);
      return new Code(copy.$code, copy.$scope);
    }
    if (isDBRefLike(value) || value.$dbPointer) {
      const v = value.$ref ? value : value.$dbPointer;
      if (v instanceof DBRef) return v;
      const dollarKeys = Object.keys(v).filter((k) => k.startsWith('$'));
      const valid = dollarKeys.every((k) => ['$ref', '$id', '$db'].includes(k));
      if (valid) {
        const { $ref, $id, $db, ...fields } = v;
        return new DBRef($ref, $id, $db, fields);
      }
    }
    return value;
  }

  function deserialize(ejson, options) {
    return parse(JSON.stringify(ejson), options);
  }

  function parse(text, options) {
    const opts = Object.assign({ relaxed: true, legacy: false, useBigInt64: false }, options);
    if (typeof opts.strict === 'boolean') opts.relaxed = !opts.strict;
    return JSON.parse(text, (key, value) => {
      if (key.indexOf('\x00') !== -1) {
        throw new BSONError(`BSON Document field names cannot contain null bytes, found: ${JSON.stringify(key)}`);
      }
      return deserializeValue(value, opts);
    });
  }

  function stringify(value, replacer, space, options) {
    if (space != null && typeof space === 'object') {
      options = space;
      space = 0;
    }
    if (replacer != null && typeof replacer === 'object' && !Array.isArray(replacer)) {
      options = replacer;
      replacer = undefined;
      space = 0;
    }
    const serializeOptions = Object.assign({ relaxed: true, legacy: false }, options);
    if (typeof serializeOptions.strict === 'boolean') serializeOptions.relaxed = !serializeOptions.strict;
    return JSON.stringify(serializeValue(value, serializeOptions, []), replacer, space);
  }

  const EJSON = Object.create(null);
  EJSON.parse = parse;
  EJSON.stringify = stringify;
  EJSON.serialize = serialize;
  EJSON.deserialize = deserialize;
  Object.freeze(EJSON);

  msh.EJSON = EJSON;
  g.EJSON = EJSON;
})(globalThis);
