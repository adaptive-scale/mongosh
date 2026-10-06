// Value formatting.
//
// mongosh prints results with Node's util.inspect, so matching its output
// means following the same algorithm: the same line-breaking rule (`compact`
// levels combined on one line while they fit in `breakLength`), the same
// column grouping for long arrays, and the same quoting of strings and keys.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const customInspect = msh.symbols.inspectCustom;

  const kObjectType = 0;
  const kArrayType = 1;
  const kArrayExtrasType = 2;
  const kMinLineWidth = 16;

  const defaultOptions = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
  };

  const colors = {
    bold: [1, 22], underline: [4, 24], grey: [90, 39], red: [31, 39], green: [32, 39],
    yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39],
  };
  const styles = {
    special: 'cyan', number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'grey',
    null: 'bold', string: 'green', symbol: 'green', date: 'magenta', regexp: 'red', module: 'underline',
  };

  function stylizeWithColor(str, styleType) {
    const style = styles[styleType];
    if (style === undefined) return str;
    const color = colors[style];
    return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }
  const stylizeNoColor = (str) => str;

  const ansi = /\u001b\[\d\d?m/g;
  const removeColors = (str) => String(str).replace(ansi, '');

  /** Display width: wide East Asian characters count as two columns. */
  function getStringWidth(str, hasColors) {
    if (hasColors) str = removeColors(str);
    let width = 0;
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code < 0x300) { width += 1; continue; }
      if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) continue;
      const wide =
        (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
      width += wide ? 2 : 1;
    }
    return width;
  }

  // ------------------------------------------------------------------
  // Strings
  // ------------------------------------------------------------------

  const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  const meta = [];
  for (let i = 0; i < 32; i++) meta[i] = '\\x' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();
  meta[8] = '\\b'; meta[9] = '\\t'; meta[10] = '\\n'; meta[12] = '\\f'; meta[13] = '\\r';
  for (let i = 32; i < 127; i++) meta[i] = '';
  meta[39] = "\\'";
  meta[92] = '\\\\';
  for (let i = 127; i < 160; i++) meta[i] = '\\x' + i.toString(16).toUpperCase();

  function addQuotes(str, quotes) {
    if (quotes === -1) return `"${str}"`;
    if (quotes === -2) return `\`${str}\``;
    return `'${str}'`;
  }

  function strEscape(str) {
    let escapeTest = strEscapeSequencesRegExp;
    let singleQuote = 39;
    // Prefer single quotes, then double quotes, then backticks -- whichever
    // needs no escaping.
    if (str.includes("'")) {
      if (!str.includes('"')) singleQuote = -1;
      else if (!str.includes('`') && !str.includes('${')) singleQuote = -2;
      if (singleQuote !== 39) escapeTest = strEscapeSequencesRegExpSingle;
    }
    if (str.length < 5000 && !escapeTest.test(str)) return addQuotes(str, singleQuote);

    let result = '';
    let last = 0;
    for (let i = 0; i < str.length; i++) {
      const point = str.charCodeAt(i);
      if (point === singleQuote || point === 92 || point < 32 || (point > 126 && point < 160)) {
        result += last === i ? meta[point] : `${str.slice(last, i)}${meta[point]}`;
        last = i + 1;
      } else if (point >= 0xd800 && point <= 0xdfff) {
        if (point <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
        }
        result += `${str.slice(last, i)}\\u${point.toString(16)}`;
        last = i + 1;
      }
    }
    if (last !== str.length) result += str.slice(last);
    return addQuotes(result, singleQuote);
  }

  function formatNumber(fn, number) {
    if (Object.is(number, -0)) return fn('-0', 'number');
    return fn(`${number}`, 'number');
  }

  function formatPrimitive(fn, value, ctx) {
    if (typeof value === 'string') {
      let trailer = '';
      if (value.length > ctx.maxStringLength) {
        const remaining = value.length - ctx.maxStringLength;
        value = value.slice(0, ctx.maxStringLength);
        trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
      }
      if (ctx.compact !== true && value.length > kMinLineWidth && value.length > ctx.breakLength - ctx.indentationLvl - 4) {
        return value.split(/(?<=\n)/).map((line) => fn(strEscape(line), 'string')).join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`) + trailer;
      }
      return fn(strEscape(value), 'string') + trailer;
    }
    if (typeof value === 'number') return formatNumber(fn, value);
    if (typeof value === 'bigint') return fn(`${value}n`, 'bigint');
    if (typeof value === 'boolean') return fn(`${value}`, 'boolean');
    if (typeof value === 'undefined') return fn('undefined', 'undefined');
    return fn(value.toString(), 'symbol');
  }

  // ------------------------------------------------------------------
  // Type checks
  // ------------------------------------------------------------------

  function brandCheck(fn) {
    return (value) => {
      try { fn(value); return true; } catch { return false; }
    };
  }
  const dateGetTime = Date.prototype.getTime;
  const isDate = brandCheck((v) => dateGetTime.call(v));
  const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
  const isRegExp = (v) => v !== RegExp.prototype && brandCheck((x) => regexpSource.call(x))(v);
  const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  const isMap = brandCheck((v) => mapSize.call(v));
  const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  const isSet = brandCheck((v) => setSize.call(v));
  const isWeakMap = brandCheck((v) => WeakMap.prototype.has.call(v, {}));
  const isWeakSet = brandCheck((v) => WeakSet.prototype.has.call(v, {}));
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  const isTypedArray = (v) => typedArrayTag.call(v) !== undefined;
  const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  const isArrayBuffer = brandCheck((v) => bufferByteLength.call(v));
  const isError = (v) => v instanceof Error || Object.prototype.toString.call(v) === '[object Error]';
  const isPromise = (v) => v instanceof Promise;
  const isArguments = (v) => Object.prototype.toString.call(v) === '[object Arguments]';

  function boxedPrimitive(value) {
    for (const [ctor, type] of [[Number, 'Number'], [String, 'String'], [Boolean, 'Boolean'], [BigInt, 'BigInt'], [Symbol, 'Symbol']]) {
      try { return { type, primitive: ctor.prototype.valueOf.call(value) }; } catch { /* not this kind */ }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Structure
  // ------------------------------------------------------------------

  function getConstructorName(obj, ctx, recurseTimes) {
    let firstProto;
    const original = obj;
    while (obj) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, 'constructor');
      if (descriptor !== undefined && typeof descriptor.value === 'function' && descriptor.value.name !== '') {
        let isInstance = false;
        try { isInstance = original instanceof descriptor.value; } catch { /* exotic constructor */ }
        if (isInstance) return String(descriptor.value.name);
      }
      obj = Object.getPrototypeOf(obj);
      if (firstProto === undefined) firstProto = obj;
    }
    if (firstProto === null) return null;
    const tag = Object.prototype.toString.call(original).slice(8, -1);
    if (recurseTimes > ctx.depth && ctx.depth !== null) return `${tag} <Complex prototype>`;
    const protoConstr = getConstructorName(firstProto, ctx, recurseTimes + 1);
    if (protoConstr === null) return `${tag} <[Object: null prototype] {}>`;
    return `${tag} <${protoConstr}>`;
  }

  function getPrefix(constructor, tag, fallback, size = '') {
    if (constructor === null) {
      if (tag !== '' && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `;
      return `[${fallback}${size}: null prototype] `;
    }
    if (tag !== '' && constructor !== tag) return `${constructor}${size} [${tag}] `;
    return `${constructor}${size} `;
  }

  function getKeys(value, showHidden) {
    const symbols = Object.getOwnPropertySymbols(value);
    if (showHidden) return Object.getOwnPropertyNames(value).concat(symbols);
    let keys;
    try { keys = Object.keys(value); } catch { keys = Object.getOwnPropertyNames(value); }
    if (symbols.length !== 0) {
      keys.push(...symbols.filter((key) => Object.prototype.propertyIsEnumerable.call(value, key)));
    }
    return keys;
  }

  const isIndex = (key) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;

  function getOwnNonIndexProperties(value, showHidden) {
    return getKeys(value, showHidden).filter((key) => !isIndex(key) && !(showHidden === false && key === 'length'));
  }

  function getClassBase(value, constructor, tag) {
    const hasName = Object.prototype.hasOwnProperty.call(value, 'name');
    const name = (hasName && value.name) || '(anonymous)';
    let base = `class ${name}`;
    if (constructor !== 'Function' && constructor !== null) base += ` [${constructor}]`;
    if (tag !== '' && constructor !== tag) base += ` [${tag}]`;
    if (constructor !== null) {
      const superName = Object.getPrototypeOf(value).name;
      if (superName) base += ` extends ${superName}`;
    } else {
      base += ' extends [null prototype]';
    }
    return `[${base}]`;
  }

  function getFunctionBase(value, constructor, tag) {
    const stringified = Function.prototype.toString.call(value);
    if (stringified.startsWith('class') && stringified.endsWith('}')) {
      const slice = stringified.slice(5, -1);
      const bracketIndex = slice.indexOf('{');
      if (bracketIndex !== -1 && (!slice.slice(0, bracketIndex).includes('(') || /^\s+[^(]*?\s+extends\s+[^(]*?\{/.test(slice))) {
        return getClassBase(value, constructor, tag);
      }
    }
    let type = 'Function';
    if (stringified.startsWith('async function*') || stringified.startsWith('async *')) type = 'AsyncGeneratorFunction';
    else if (stringified.startsWith('async')) type = 'AsyncFunction';
    else if (stringified.startsWith('function*')) type = 'GeneratorFunction';
    let base = `[${type}`;
    if (constructor === null) base += ' (null prototype)';
    if (value.name === '' || typeof value.name !== 'string') base += ' (anonymous)';
    else base += `: ${value.name}`;
    base += ']';
    if (constructor !== type && constructor !== null) base += ` ${constructor}`;
    if (tag !== '' && constructor !== tag) base += ` [${tag}]`;
    return base;
  }

  function errorStack(err) {
    const name = err.name != null ? String(err.name) : 'Error';
    const message = err.message != null ? String(err.message) : '';
    const head = message ? `${name}: ${message}` : name;
    let frames = '';
    try {
      if (typeof err.stack === 'string') frames = err.stack.replace(/\s+$/, '');
    } catch { /* stack getter threw */ }
    if (frames.startsWith(head)) return frames;
    return frames ? `${head}\n${frames}` : head;
  }

  function formatError(err, constructor, tag, ctx, keys) {
    for (const name of ['name', 'message', 'stack']) {
      const index = keys.indexOf(name);
      if (index !== -1) keys.splice(index, 1);
    }
    if ('cause' in err && !keys.includes('cause')) keys.push('cause');
    let stack = errorStack(err);
    if (!stack.includes('\n    at')) stack = `[${stack}]`;
    if (ctx.indentationLvl !== 0) stack = stack.replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`);
    return stack;
  }

  const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

  function formatProperty(ctx, value, recurseTimes, key, type, desc) {
    let name, str;
    let extra = ' ';
    desc = desc || Object.getOwnPropertyDescriptor(value, key) || { value: value[key], enumerable: true };
    if (desc.value !== undefined) {
      const diff = ctx.compact !== true || type !== kObjectType ? 2 : 3;
      ctx.indentationLvl += diff;
      str = formatValue(ctx, desc.value, recurseTimes);
      if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) extra = `\n${' '.repeat(ctx.indentationLvl)}`;
      ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
      const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
      if (ctx.getters) {
        try {
          const tmp = desc.get.call(value);
          ctx.indentationLvl += 2;
          str = tmp === null || typeof tmp !== 'object'
            ? `${ctx.stylize(`[${label}:`, 'special')} ${formatPrimitive(ctx.stylize, tmp, ctx)}${ctx.stylize(']', 'special')}`
            : `${ctx.stylize(`[${label}]`, 'special')} ${formatValue(ctx, tmp, recurseTimes)}`;
          ctx.indentationLvl -= 2;
        } catch (err) {
          str = ctx.stylize(`[${label}: <Inspection threw (${err && err.message})>]`, 'special');
        }
      } else {
        str = ctx.stylize(`[${label}]`, 'special');
      }
    } else if (desc.set !== undefined) {
      str = ctx.stylize('[Setter]', 'special');
    } else {
      str = ctx.stylize('undefined', 'undefined');
    }
    if (type === kArrayType) return str;
    if (typeof key === 'symbol') {
      name = ctx.stylize(key.toString(), 'symbol');
    } else if (key === '__proto__') {
      name = "['__proto__']";
    } else if (desc.enumerable === false) {
      name = `[${key}]`;
    } else if (keyStrRegExp.test(key)) {
      name = ctx.stylize(key, 'name');
    } else {
      name = ctx.stylize(strEscape(key), 'string');
    }
    return `${name}:${extra}${str}`;
  }

  const remainingText = (remaining) => `... ${remaining} more item${remaining > 1 ? 's' : ''}`;

  function formatArray(ctx, value, recurseTimes) {
    const valLen = value.length;
    const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);
    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      // Sparse arrays print their holes as "<n empty items>".
      if (!Object.prototype.hasOwnProperty.call(value, i)) return formatSparseArray(ctx, value, recurseTimes, len, output, i);
      output.push(formatProperty(ctx, value, recurseTimes, i, kArrayType));
    }
    if (remaining > 0) output.push(remainingText(remaining));
    return output;
  }

  function formatSparseArray(ctx, value, recurseTimes, maxLength, output, i) {
    const keys = Object.keys(value).filter(isIndex);
    let index = i;
    for (; i < keys.length && output.length < maxLength; i++) {
      const key = keys[i];
      const tmp = Number(key);
      if (tmp > 4294967294) break;
      if (`${index}` !== key) {
        const emptyItems = tmp - index;
        output.push(ctx.stylize(`<${emptyItems} empty item${emptyItems > 1 ? 's' : ''}>`, 'undefined'));
        index = tmp;
        if (output.length >= maxLength) break;
      }
      output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
      index++;
    }
    const remaining = value.length - index;
    if (output.length < maxLength) {
      if (remaining > 0) output.push(ctx.stylize(`<${remaining} empty item${remaining > 1 ? 's' : ''}>`, 'undefined'));
    } else if (remaining > 0) {
      output.push(remainingText(remaining));
    }
    return output;
  }

  function formatTypedArray(ctx, value) {
    const length = value.length;
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
    const remaining = length - maxLength;
    const output = new Array(maxLength);
    for (let i = 0; i < maxLength; ++i) {
      output[i] = typeof value[i] === 'bigint' ? ctx.stylize(`${value[i]}n`, 'bigint') : formatNumber(ctx.stylize, value[i]);
    }
    if (remaining > 0) output[maxLength] = remainingText(remaining);
    return output;
  }

  function formatArrayBuffer(ctx, value) {
    const buffer = new Uint8Array(value);
    const shown = Math.min(Math.max(0, ctx.maxArrayLength), buffer.length);
    let str = Array.from(buffer.slice(0, shown), (b) => (b < 16 ? '0' : '') + b.toString(16)).join(' ');
    const remaining = buffer.length - shown;
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
  }

  function formatSet(ctx, value, recurseTimes) {
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), value.size);
    const remaining = value.size - maxLength;
    const output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const v of value) {
      if (i++ >= maxLength) break;
      output.push(formatValue(ctx, v, recurseTimes));
    }
    if (remaining > 0) output.push(remainingText(remaining));
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatMap(ctx, value, recurseTimes) {
    const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), value.size);
    const remaining = value.size - maxLength;
    const output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const [k, v] of value) {
      if (i++ >= maxLength) break;
      output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
    }
    if (remaining > 0) output.push(remainingText(remaining));
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatPromise(ctx, value, recurseTimes) {
    const [state, result] = msh.native.promiseState(value);
    if (state === 'pending') return [ctx.stylize('<pending>', 'special')];
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, result, recurseTimes);
    ctx.indentationLvl -= 2;
    return [state === 'rejected' ? `${ctx.stylize('<rejected>', 'special')} ${str}` : str];
  }

  /** Lay out a long array in aligned columns when its entries are short. */
  function groupArrayElements(ctx, output, value) {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    // The trailing "... n more items" entry is not part of the grid.
    if (ctx.maxArrayLength < output.length) outputLength--;
    const separatorSpace = 2;
    const dataLen = new Array(outputLength);
    for (; i < outputLength; i++) {
      const len = getStringWidth(output[i], ctx.colors);
      dataLen[i] = len;
      totalLength += len + separatorSpace;
      if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
      const approxCharHeights = 2.5;
      const averageBias = Math.sqrt(actualMax - totalLength / output.length);
      const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
      const columns = Math.min(
        Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
        Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        ctx.compact * 4,
        15,
      );
      if (columns <= 1) return output;
      const tmp = [];
      const maxLineLength = [];
      for (let i = 0; i < columns; i++) {
        let lineLength = 0;
        for (let j = i; j < output.length; j += columns) {
          if (dataLen[j] > lineLength) lineLength = dataLen[j];
        }
        maxLineLength.push(lineLength + separatorSpace);
      }
      // Numbers are right-aligned, everything else left-aligned.
      let padStart = true;
      if (value !== undefined) {
        for (let i = 0; i < output.length; i++) {
          if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') { padStart = false; break; }
        }
      }
      for (let i = 0; i < outputLength; i += columns) {
        const max = Math.min(i + columns, outputLength);
        let str = '';
        let j = i;
        for (; j < max - 1; j++) {
          const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
          str += padStart ? `${output[j]}, `.padStart(padding, ' ') : `${output[j]}, `.padEnd(padding, ' ');
        }
        if (padStart) {
          const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
          str += output[j].padStart(padding, ' ');
        } else {
          str += output[j];
        }
        tmp.push(str);
      }
      if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
      output = tmp;
    }
    return output;
  }

  function isBelowBreakLength(ctx, output, start, base) {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (let i = 0; i < output.length; i++) {
      totalLength += ctx.colors ? removeColors(output[i]).length : output[i].length;
      if (totalLength > ctx.breakLength) return false;
    }
    return base === '' || !base.includes('\n');
  }

  function reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value) {
    if (ctx.compact !== true) {
      if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
        const entries = output.length;
        if (extrasType === kArrayExtrasType && entries > 6) output = groupArrayElements(ctx, output, value);
        // Combine on one line only when the object nests at most `compact`
        // levels and was not laid out as a grid.
        if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
          const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
          if (isBelowBreakLength(ctx, output, start, base)) {
            const joinedOutput = output.join(', ');
            if (!joinedOutput.includes('\n')) {
              return `${base ? `${base} ` : ''}${braces[0]} ${joinedOutput}` + ` ${braces[1]}`;
            }
          }
        }
      }
      const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
      return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) {
      return `${braces[0]}${base ? ` ${base}` : ''} ${output.join(', ')} ` + braces[1];
    }
    const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
    const ln = base === '' && braces[0].length === 1 ? ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
    return `${braces[0]}${ln}${output.join(`,${indentation}  `)} ${braces[1]}`;
  }

  function userOptions(ctx) {
    const options = { stylize: ctx.stylize };
    for (const key of Object.keys(defaultOptions)) options[key] = ctx[key];
    return options;
  }

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (typeof value !== 'object' && typeof value !== 'function') return formatPrimitive(ctx.stylize, value, ctx);
    if (value === null) return ctx.stylize('null', 'null');

    if (ctx.customInspect) {
      let maybeCustom;
      try { maybeCustom = value[customInspect]; } catch { /* getter threw */ }
      if (typeof maybeCustom === 'function' && !(value.constructor && value.constructor.prototype === value)) {
        const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
        const ret = maybeCustom.call(value, depth, userOptions(ctx), inspect);
        if (ret !== value) {
          const text = typeof ret !== 'object' ? `${ret}` : formatValue(ctx, ret, recurseTimes);
          return text.replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`);
        }
      }
    }

    // Documents that came from the server are always shown in full. mongosh
    // does this by inspecting each of their objects and arrays on its own,
    // so each one is laid out as if it were the top-level value: unlimited
    // depth and length, and no limit on how many levels share a line.
    if (msh.serverValues.has(value) && !ctx.seen.includes(value)) {
      const fresh = {
        ...ctx,
        seen: [],
        indentationLvl: 0,
        currentDepth: 0,
        circular: undefined,
        depth: Infinity,
        maxArrayLength: Infinity,
        maxStringLength: Infinity,
      };
      return formatRaw(fresh, value, 0).replaceAll('\n', `\n${' '.repeat(ctx.indentationLvl)}`);
    }

    if (ctx.seen.includes(value)) {
      let index = 1;
      if (ctx.circular === undefined) {
        ctx.circular = new Map();
        ctx.circular.set(value, index);
      } else {
        index = ctx.circular.get(value);
        if (index === undefined) {
          index = ctx.circular.size + 1;
          ctx.circular.set(value, index);
        }
      }
      return ctx.stylize(`[Circular *${index}]`, 'special');
    }
    return formatRaw(ctx, value, recurseTimes, typedArray);
  }

  function formatRaw(ctx, value, recurseTimes, typedArray) {
    let keys;
    const constructor = getConstructorName(value, ctx, recurseTimes);
    let tag = value[Symbol.toStringTag];
    if (typeof tag !== 'string' || (tag !== '' && Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag))) tag = '';

    let base = '';
    let formatter = () => [];
    let braces;
    let noIterator = true;
    let extrasType = kObjectType;

    if (Symbol.iterator in value || constructor === null) {
      noIterator = false;
      if (Array.isArray(value)) {
        const prefix = constructor !== 'Array' || tag !== '' ? getPrefix(constructor, tag, 'Array', `(${value.length})`) : '';
        keys = getOwnNonIndexProperties(value, ctx.showHidden);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
        extrasType = kArrayExtrasType;
        formatter = formatArray;
      } else if (isSet(value)) {
        const size = value.size;
        const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = formatSet;
        if (size === 0 && keys.length === 0) return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (isMap(value)) {
        const size = value.size;
        const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = formatMap;
        if (size === 0 && keys.length === 0) return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (isTypedArray(value)) {
        keys = getOwnNonIndexProperties(value, ctx.showHidden);
        const fallback = typedArrayTag.call(value);
        const prefix = getPrefix(constructor, tag, fallback, `(${value.length})`);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
        formatter = formatTypedArray;
        extrasType = kArrayExtrasType;
      } else {
        noIterator = true;
      }
    }

    if (noIterator) {
      keys = getKeys(value, ctx.showHidden);
      braces = ['{', '}'];
      const boxed = typeof value === 'function' ? null : boxedPrimitive(value);
      if (typeof value === 'function') {
        base = getFunctionBase(value, constructor, tag);
        if (keys.length === 0) return ctx.stylize(base, 'special');
      } else if (constructor === 'Object') {
        if (isArguments(value)) braces[0] = '[Arguments] {';
        else if (tag !== '') braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
        if (keys.length === 0) return `${braces[0]}}`;
      } else if (isRegExp(value)) {
        base = RegExp.prototype.toString.call(value);
        const prefix = getPrefix(constructor, tag, 'RegExp');
        if (prefix !== 'RegExp ') base = `${prefix}${base}`;
        if (keys.length === 0 || (recurseTimes > ctx.depth && ctx.depth !== null)) return ctx.stylize(base, 'regexp');
      } else if (isDate(value)) {
        // mongosh shows dates the way they are written in the shell.
        base = Number.isNaN(dateGetTime.call(value))
          ? ctx.stylize('Invalid Date', 'date')
          : `ISODate('${Date.prototype.toISOString.call(value)}')`;
        if (keys.length === 0) return base;
      } else if (isError(value)) {
        base = formatError(value, constructor, tag, ctx, keys);
        if (keys.length === 0) return base;
      } else if (isArrayBuffer(value)) {
        const prefix = getPrefix(constructor, tag, 'ArrayBuffer');
        if (typedArray === undefined) {
          formatter = formatArrayBuffer;
        } else if (keys.length === 0) {
          return prefix + `{ byteLength: ${formatNumber(ctx.stylize, value.byteLength)} }`;
        }
        braces[0] = `${prefix}{`;
        keys.unshift('byteLength');
      } else if (isPromise(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
        formatter = formatPromise;
      } else if (isWeakSet(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
        formatter = () => [ctx.stylize('<items unknown>', 'special')];
      } else if (isWeakMap(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
        formatter = () => [ctx.stylize('<items unknown>', 'special')];
      } else if (boxed !== null) {
        const { type, primitive } = boxed;
        base = `[${type}`;
        if (type !== constructor) base += constructor === null ? ' (null prototype)' : ` (${constructor})`;
        base += `: ${formatPrimitive(stylizeNoColor, primitive, ctx)}]`;
        if (tag !== '' && tag !== constructor) base += ` [${tag}]`;
        base = ctx.stylize(base, type.toLowerCase());
        if (type === 'String') keys = keys.filter((key) => !isIndex(key));
        if (keys.length === 0) return base;
      } else {
        if (keys.length === 0) return `${getPrefix(constructor, tag, 'Object')}{}`;
        braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
      }
    }

    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      let constructorName = getPrefix(constructor, tag, 'Object').slice(0, -1);
      if (constructor !== null) constructorName = `[${constructorName}]`;
      return ctx.stylize(constructorName, 'special');
    }
    recurseTimes += 1;

    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    let output;
    try {
      output = formatter(ctx, value, recurseTimes);
      for (let i = 0; i < keys.length; i++) {
        // byteLength is a prototype getter; show it as a plain number.
        if (formatter === formatArrayBuffer && keys[i] === 'byteLength') {
          output.push(`[byteLength]: ${formatNumber(ctx.stylize, value.byteLength)}`);
          continue;
        }
        output.push(formatProperty(ctx, value, recurseTimes, keys[i], extrasType));
      }
    } catch (err) {
      ctx.seen.pop();
      if (err instanceof RangeError || (err && /stack/i.test(String(err.message)))) {
        return ctx.stylize(`[${getPrefix(constructor, tag, 'Object').slice(0, -1)}: Inspection interrupted prematurely. Maximum call stack size exceeded.]`, 'special');
      }
      throw err;
    }
    if (ctx.circular !== undefined) {
      const index = ctx.circular.get(value);
      if (index !== undefined) {
        const reference = ctx.stylize(`<ref *${index}>`, 'special');
        if (ctx.compact !== true) base = base === '' ? reference : `${reference} ${base}`;
        else braces[0] = `${reference} ${braces[0]}`;
      }
    }
    ctx.seen.pop();

    if (ctx.sorted) {
      const comparator = ctx.sorted === true ? undefined : ctx.sorted;
      if (extrasType === kObjectType) output.sort(comparator);
      else if (keys.length > 1) {
        const sorted = output.slice(output.length - keys.length).sort(comparator);
        output.splice(output.length - keys.length, keys.length, ...sorted);
      }
    }
    return reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
  }

  function inspect(value, opts) {
    const ctx = {
      seen: [],
      indentationLvl: 0,
      currentDepth: 0,
      circular: undefined,
      stylize: stylizeNoColor,
      ...defaultOptions,
    };
    if (opts !== null && typeof opts === 'object') {
      for (const key of Object.keys(opts)) {
        if (key in defaultOptions && opts[key] !== undefined) ctx[key] = opts[key];
      }
      if (typeof opts.stylize === 'function' && opts.colors === undefined) ctx.stylize = opts.stylize;
    }
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
  }
  inspect.custom = customInspect;
  inspect.defaultOptions = defaultOptions;

  msh.inspect = inspect;
  msh.strEscape = strEscape;
  msh.removeColors = removeColors;
  msh.stylize = (str, style) => (msh.config.colors ? stylizeWithColor(str, style) : str);
})(globalThis);
