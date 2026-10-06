// Shell internals shared by every other source file.
//
// Everything internal hangs off `__msh`, which is hidden from enumeration so
// the user's global scope only shows the shell API.
(function (g) {
  'use strict';

  const native = g.__native;
  const msh = {};
  Object.defineProperty(g, '__msh', { value: msh, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(g, '__native', { value: native, enumerable: false, writable: false, configurable: false });

  msh.native = native;
  msh.version = native.version;

  // Captured before user code can reassign the globals.
  msh.intrinsics = {
    Date: g.Date,
    RegExp: g.RegExp,
    Map: g.Map,
    mapEntries: (map) => Array.from(map.entries()),
  };

  msh.config = {
    interactive: false,
    quiet: false,
    colors: false,
    isTTY: false,
    json: null,
    deepInspect: undefined,
    serverApi: null,
    // User-tunable settings, exposed through the `config` global.
    user: {
      displayBatchSize: 20,
      maxTimeMS: null,
      inspectCompact: 3,
      inspectDepth: 6,
      historyLength: 1000,
      showStackTraces: false,
      redactHistory: 'remove',
      enableTelemetry: false,
      editor: null,
    },
  };

  msh.symbols = {
    asPrintable: Symbol.for('@@mongosh.asPrintable'),
    shellApiType: Symbol.for('@@mongosh.shellApiType'),
    inspectCustom: Symbol.for('nodejs.util.inspect.custom'),
  };

  msh.NOT_A_COMMAND = Symbol('not a shell command');

  // ------------------------------------------------------------------
  // Output
  // ------------------------------------------------------------------

  msh.write = (text) => native.write(String(text), false);
  msh.println = (text) => native.write(String(text) + '\n', false);

  const warned = new Set();
  /** Print a warning the first time it comes up in this session. */
  msh.warnOnce = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    msh.println(message);
  };
  msh.deprecated = (message) => msh.warnOnce(`DeprecationWarning: ${message}`);

  // ------------------------------------------------------------------
  // Timers. The engine has no event loop; the evaluator calls runTimers()
  // whenever a script is waiting on a promise and the job queue is empty.
  // ------------------------------------------------------------------

  const timers = [];
  let nextTimerId = 1;

  function schedule(fn, delay, repeat, args) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const ms = Math.max(0, Number(delay) || 0);
    const timer = { id: nextTimerId++, fn, at: Date.now() + ms, every: repeat ? Math.max(1, ms) : 0, args };
    timers.push(timer);
    return timer.id;
  }

  function cancel(id) {
    const index = timers.findIndex((t) => t.id === id);
    if (index !== -1) timers.splice(index, 1);
  }

  /**
   * Run every timer that is due. Returns 0 when something ran, the number of
   * milliseconds until the next timer otherwise, or -1 when none are pending.
   */
  msh.runTimers = function () {
    if (timers.length === 0) return -1;
    const now = Date.now();
    let ran = false;
    for (const timer of timers.slice().sort((a, b) => a.at - b.at)) {
      if (timer.at > now) break;
      if (!timers.includes(timer)) continue;
      if (timer.every) timer.at = now + timer.every;
      else cancel(timer.id);
      ran = true;
      timer.fn(...timer.args);
    }
    if (ran) return 0;
    let next = Infinity;
    for (const timer of timers) next = Math.min(next, timer.at - now);
    return Math.max(1, next);
  };

  g.setTimeout = (fn, delay, ...args) => schedule(fn, delay, false, args);
  g.setInterval = (fn, delay, ...args) => schedule(fn, delay, true, args);
  g.setImmediate = (fn, ...args) => schedule(fn, 0, false, args);
  g.clearTimeout = g.clearInterval = g.clearImmediate = (id) => cancel(id);

  // Objects and arrays that were read from the server (see inspect.js).
  msh.serverValues = new WeakSet();

  function markServerValue(value) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      msh.serverValues.add(value);
      for (let i = 0; i < value.length; i++) markServerValue(value[i]);
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      msh.serverValues.add(value);
      for (const key of Object.keys(value)) markServerValue(value[key]);
    }
  }

  /**
   * Tag a value read from the server so it is printed in full. Only the
   * interactive shell does this (--deep-inspect), scripts skip the walk.
   */
  msh.fromServer = function (value) {
    if (msh.config.deepInspect) markServerValue(value);
    return value;
  };

  /** Tag a container built locally out of server values, e.g. toArray(). */
  msh.serverContainer = function (value) {
    if (msh.config.deepInspect) msh.serverValues.add(value);
    return value;
  };

  /** A promise for a thenable value; anything else comes back unchanged. */
  msh.thenableToPromise = function (value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    let then;
    try {
      then = value.then;
    } catch {
      return value;
    }
    return typeof then === 'function' ? Promise.resolve(value) : value;
  };

  // ------------------------------------------------------------------
  // Byte helpers
  // ------------------------------------------------------------------

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_LOOKUP = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
  B64_LOOKUP['-'.charCodeAt(0)] = 62;
  B64_LOOKUP['_'.charCodeAt(0)] = 63;

  const bytes = (msh.bytes = {});

  bytes.toBase64 = function (u8) {
    let out = '';
    let i = 0;
    for (; i + 2 < u8.length; i += 3) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i + 1 === u8.length) {
      const n = u8[i] << 16;
      out += B64[n >> 18] + B64[(n >> 12) & 63] + '==';
    } else if (i + 2 === u8.length) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
    }
    return out;
  };

  bytes.fromBase64 = function (text) {
    const clean = String(text).replace(/[\s=]+/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let at = 0;
    for (let i = 0; i < clean.length; i++) {
      const code = clean.charCodeAt(i);
      const value = code < 128 ? B64_LOOKUP[code] : -1;
      if (value < 0) continue;
      acc = (acc << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[at++] = (acc >> bits) & 0xff;
      }
    }
    return at === out.length ? out : out.slice(0, at);
  };

  bytes.toHex = function (u8) {
    let out = '';
    for (let i = 0; i < u8.length; i++) out += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return out;
  };

  /** Decodes hex pairs, stopping at the first invalid one (as Node does). */
  bytes.fromHex = function (hex) {
    const text = String(hex);
    const out = new Uint8Array(text.length >> 1);
    let n = 0;
    for (; n < out.length; n++) {
      const pair = text.substr(n * 2, 2);
      if (!/^[0-9a-fA-F]{2}$/.test(pair)) break;
      out[n] = parseInt(pair, 16);
    }
    return n === out.length ? out : out.slice(0, n);
  };

  bytes.fromUtf8 = function (text) {
    const str = String(text);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  };

  /** UTF-8 decoding with U+FFFD for malformed input, like TextDecoder. */
  bytes.toUtf8 = function (u8) {
    let out = '';
    const n = u8.length;
    let i = 0;
    while (i < n) {
      const lead = u8[i];
      if (lead < 0x80) {
        out += String.fromCharCode(lead);
        i++;
        continue;
      }
      let need;
      let cp;
      if (lead >= 0xc2 && lead <= 0xdf) { need = 1; cp = lead & 0x1f; }
      else if (lead >= 0xe0 && lead <= 0xef) { need = 2; cp = lead & 0x0f; }
      else if (lead >= 0xf0 && lead <= 0xf4) { need = 3; cp = lead & 0x07; }
      else {
        out += '\ufffd';
        i++;
        continue;
      }
      let j = i + 1;
      let valid = true;
      for (let k = 0; k < need; k++, j++) {
        let lo = 0x80;
        let hi = 0xbf;
        if (k === 0) {
          if (lead === 0xe0) lo = 0xa0;
          else if (lead === 0xed) hi = 0x9f;
          else if (lead === 0xf0) lo = 0x90;
          else if (lead === 0xf4) hi = 0x8f;
        }
        if (j >= n || u8[j] < lo || u8[j] > hi) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (u8[j] & 0x3f);
      }
      // A bad continuation byte is not consumed: it may start a new character.
      out += valid ? String.fromCodePoint(cp) : '\ufffd';
      i = j;
    }
    return out;
  };

  bytes.fromLatin1 = function (text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  };

  g.btoa = (text) => bytes.toBase64(bytes.fromLatin1(String(text)));
  g.atob = (text) => {
    const u8 = bytes.fromBase64(text);
    let out = '';
    for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
    return out;
  };

  // ------------------------------------------------------------------
  // Small shared utilities
  // ------------------------------------------------------------------

  msh.isPlainObject = (value) => {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  // The engine has no ICU, so sorting names the way Node's localeCompare
  // does is done by hand: punctuation, then digits, then letters ignoring
  // case, with lowercase first among otherwise equal strings.
  const PUNCTUATION_ORDER = ' _-,;:!?.\'"()[]{}@*/\\&#%`^+<=>|~$';
  function collationRank(ch) {
    const punct = PUNCTUATION_ORDER.indexOf(ch);
    if (punct !== -1) return punct;
    const code = ch.toLowerCase().codePointAt(0);
    if (code >= 48 && code <= 57) return 100 + (code - 48);
    return 1000 + code;
  }
  msh.localeCompare = function (a, b) {
    const left = Array.from(String(a));
    const right = Array.from(String(b));
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const diff = collationRank(left[i]) - collationRank(right[i]);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] === left[i].toLowerCase() ? -1 : 1;
    }
    return 0;
  };

  /** Define properties that should not show up when an object is printed. */
  msh.hide = (target, props) => {
    for (const key of Object.keys(props)) {
      Object.defineProperty(target, key, { value: props[key], enumerable: false, writable: true, configurable: true });
    }
    return target;
  };
})(globalThis);
