// Error classes with the names and messages mongosh users see, the mapping
// from native driver failures onto them, and error formatting.
(function (g) {
  'use strict';

  const msh = g.__msh;

  function defineError(name, Base = Error, init) {
    const cls = {
      [name]: class extends Base {
        constructor(message, ...rest) {
          // Extra arguments (code, server reply, ...) are for our own base
          // classes; the built-in Error would read them as options.
          if (Base === Error) super(message);
          else super(message, ...rest);
          if (init) init.call(this, message, ...rest);
        }
      },
    }[name];
    Object.defineProperty(cls.prototype, 'name', { value: name, enumerable: false, writable: true, configurable: true });
    return cls;
  }

  // Shell errors carry a documented code, shown as a `[CODE]` prefix.
  const MongoshBaseError = defineError('MongoshBaseError', Error, function (message, code, metadata) {
    if (code) {
      this.code = code;
      this.message = `[${code}] ${message}`;
    }
    if (metadata) this.metadata = metadata;
  });
  const shellError = (name) => defineError(name, MongoshBaseError);
  const MongoshInvalidInputError = shellError('MongoshInvalidInputError');
  const MongoshRuntimeError = shellError('MongoshRuntimeError');
  const MongoshInternalError = shellError('MongoshInternalError');
  const MongoshUnimplementedError = shellError('MongoshUnimplementedError');
  const MongoshDeprecatedError = shellError('MongoshDeprecatedError');
  const MongoshCommandFailed = shellError('MongoshCommandFailed');
  const MongoshWarning = shellError('MongoshWarning');
  const MongoshInterruptedError = defineError('MongoshInterruptedError', Error);

  // Driver errors.
  const MongoError = defineError('MongoError', Error, function () {
    if (!(this.errorLabelSet instanceof Set)) this.errorLabelSet = new Set();
  });
  Object.defineProperty(MongoError.prototype, 'errmsg', {
    get() { return this.message; },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(MongoError.prototype, 'errorLabels', {
    get() { return Array.from(this.errorLabelSet); },
    enumerable: false,
    configurable: true,
  });
  msh.hide(MongoError.prototype, {
    hasErrorLabel(label) { return this.errorLabelSet.has(label); },
    addErrorLabel(label) { this.errorLabelSet.add(label); },
  });
  const MongoDriverError = defineError('MongoDriverError', MongoError);
  const MongoAPIError = defineError('MongoAPIError', MongoDriverError);
  const MongoRuntimeError = defineError('MongoRuntimeError', MongoDriverError);
  const MongoInvalidArgumentError = defineError('MongoInvalidArgumentError', MongoAPIError);
  const MongoCursorExhaustedError = defineError('MongoCursorExhaustedError', MongoAPIError);
  const MongoCursorInUseError = defineError('MongoCursorInUseError', MongoAPIError);
  const MongoBatchReExecutionError = defineError('MongoBatchReExecutionError', MongoAPIError);
  const MongoNotConnectedError = defineError('MongoNotConnectedError', MongoAPIError);
  const MongoExpiredSessionError = defineError('MongoExpiredSessionError', MongoAPIError);
  const MongoTransactionError = defineError('MongoTransactionError', MongoAPIError);
  const MongoParseError = defineError('MongoParseError', MongoDriverError);
  const MongoNetworkError = defineError('MongoNetworkError', MongoError);
  const MongoNetworkTimeoutError = defineError('MongoNetworkTimeoutError', MongoNetworkError);
  const MongoServerSelectionError = defineError('MongoServerSelectionError', MongoError);
  // Own properties come out in the driver's order: errorLabelSet (set by
  // MongoError), errorResponse, then the fields of the server reply.
  const MongoServerError = defineError('MongoServerError', MongoError, function (message, response) {
    if (response && typeof response === 'object' && !('errorResponse' in this)) {
      this.errorResponse = response;
      for (const key of Object.keys(response)) {
        if (key !== 'errorLabels' && key !== 'errmsg' && key !== 'message' && key !== 'errorResponse') this[key] = response[key];
      }
      if (Array.isArray(response.errorLabels)) {
        for (const label of response.errorLabels) this.errorLabelSet.add(label);
      }
    }
  });
  const MongoWriteConcernError = defineError('MongoWriteConcernError', MongoServerError);
  const MongoBulkWriteError = defineError('MongoBulkWriteError', MongoServerError, function (message, response, result) {
    if (!Array.isArray(this.writeErrors)) this.writeErrors = [];
    this.result = result;
  });
  for (const key of ['insertedCount', 'matchedCount', 'modifiedCount', 'deletedCount', 'upsertedCount', 'insertedIds', 'upsertedIds']) {
    Object.defineProperty(MongoBulkWriteError.prototype, key, {
      get() { return this.result ? this.result[key] : undefined; },
      enumerable: false,
      configurable: true,
    });
  }

  msh.errors = {
    MongoshBaseError, MongoshInvalidInputError, MongoshRuntimeError, MongoshInternalError,
    MongoshUnimplementedError, MongoshDeprecatedError, MongoshCommandFailed, MongoshWarning,
    MongoshInterruptedError, MongoError, MongoDriverError, MongoAPIError, MongoRuntimeError,
    MongoInvalidArgumentError, MongoCursorExhaustedError, MongoCursorInUseError, MongoBatchReExecutionError,
    MongoNotConnectedError,
    MongoExpiredSessionError, MongoTransactionError, MongoParseError, MongoNetworkError,
    MongoNetworkTimeoutError, MongoServerSelectionError, MongoServerError, MongoWriteConcernError,
    MongoBulkWriteError,
  };

  msh.invalidInput = (message) => new MongoshInvalidInputError(message, 'COMMON-10001');

  msh.interruptedError = () => new MongoshInterruptedError('execution was interrupted');

  // ------------------------------------------------------------------
  // Native driver errors
  // ------------------------------------------------------------------

  /** "connect ECONNREFUSED host:port" for an unreachable server, like Node. */
  /** Strip the driver's own framing from the text of an error it reports. */
  function cleanDriverText(text) {
    return String(text)
      .replace(/,?\s*labels: \{[^}]*\}/g, '')
      .replace(/^Kind: /, '')
      .replace(/^I\/O error: /, '')
      .replace(/,\s*(source|server response|wire_version): None/g, '')
      .trim();
  }

  /** The server's own message from an authentication failure, if it has one. */
  function authenticationMessage(text) {
    const cleaned = cleanDriverText(text).replace(/^[A-Z0-9-]+ failure: /, '');
    const fromServer = /Command failed: Error code \d+ \([^)]*\): (.*?)(, labels|$)/.exec(cleaned);
    if (fromServer) return fromServer[1].trim();
    return /^(Authentication failed|Could not find user|.*not authorized)/i.test(cleaned) ? cleaned : 'Authentication failed.';
  }

  function describeSelectionFailure(message) {
    const address = /Address: ([^,\s]+), Type: Unknown, Error: (.*?)(?:\s*\}\s*(?:,\s*\{|\]))/.exec(message) ||
      /Address: ([^,\s]+), Type: Unknown, Error: ([^}]*)/.exec(message);
    if (address) {
      const [, hostPort] = address;
      const reason = cleanDriverText(address[2]);
      if (/refused/i.test(reason)) return { network: true, message: `connect ECONNREFUSED ${hostPort}` };
      if (/Authentication failed|[A-Z0-9-]+ failure:|AuthenticationFailed|Could not find user/i.test(reason)) {
        return { auth: true, message: authenticationMessage(reason) };
      }
      if (/timed out|timeout/i.test(reason)) return { network: true, message: `connect ETIMEDOUT ${hostPort}` };
      if (/No such host|failed to lookup|nodename nor servname|Name or service not known|resolve/i.test(reason)) {
        return { network: true, message: `getaddrinfo ENOTFOUND ${hostPort.replace(/:\d+$/, '')}` };
      }
      if (/tls|ssl|certificate|handshake/i.test(reason)) return { network: true, message: reason };
      // Anything else: say which server and why, without the topology dump.
      return { message: `connection to ${hostPort} failed: ${reason}` };
    }
    return { message: cleanDriverText(message).replace(/^Server selection timeout: /, 'Server selection timed out: ') };
  }

  msh.driverError = function (info) {
    const labels = info.errorLabels || [];
    let error;
    switch (info.kind) {
      case 'command': {
        const response = info.response || { ok: 0, errmsg: info.message, code: info.code, codeName: info.codeName };
        error = new MongoServerError(info.message, response);
        break;
      }
      case 'authentication': {
        const message = authenticationMessage(info.message);
        error = new MongoServerError(message, { ok: 0, errmsg: message, code: 18, codeName: 'AuthenticationFailed' });
        break;
      }
      case 'serverSelection': {
        const described = describeSelectionFailure(info.message);
        if (described.auth) {
          error = new MongoServerError(described.message, { ok: 0, errmsg: described.message, code: 18, codeName: 'AuthenticationFailed' });
        } else if (described.network) {
          error = new MongoNetworkError(described.message);
        } else {
          error = new MongoServerSelectionError(described.message);
        }
        break;
      }
      case 'network':
        error = new MongoNetworkError(cleanDriverText(info.message));
        break;
      case 'dns':
        error = new MongoNetworkError(info.message);
        break;
      case 'invalidArgument':
        error = new MongoInvalidArgumentError(info.message);
        break;
      case 'transaction':
        error = new MongoTransactionError(info.message);
        break;
      default:
        error = new MongoRuntimeError(info.message);
    }
    for (const label of labels) error.addErrorLabel(label);
    return error;
  };

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  const isErrorLike = (value) => value instanceof Error ||
    (value !== null && typeof value === 'object' && typeof value.message === 'string' && typeof value.name === 'string');

  /** Non-Error values that were thrown are reported as `Error: <value>`. */
  function normalize(thrown) {
    if (isErrorLike(thrown)) return thrown;
    const text = typeof thrown === 'string' ? thrown : msh.inspect(thrown, { depth: 6, breakLength: Infinity });
    return new Error(text);
  }

  function syntaxErrorFrame(error) {
    // The engine reports "file:line:column" in the stack of a syntax error.
    const source = msh.lastSource;
    const where = /:(\d+):(\d+)/.exec(String(error.stack || ''));
    if (!source || !where) return '';
    const line = Number(where[1]);
    const column = Number(where[2]);
    const lines = source.split('\n');
    if (line < 1 || line > lines.length) return '';
    const gutter = String(line).length;
    return `\n\n> ${String(line).padStart(gutter)} | ${lines[line - 1]}\n  ${' '.repeat(gutter)} | ${' '.repeat(Math.max(0, column - 1))}^`;
  }

  const isWord = (ch) => ch !== undefined && /[\w$]/.test(ch);

  /** Index where the expression ending just before `end` starts. */
  function expressionStart(src, end) {
    let i = end - 1;
    const skipSpace = () => { while (i >= 0 && /\s/.test(src[i])) i--; };
    for (;;) {
      skipSpace();
      const ch = src[i];
      if (ch === ')' || ch === ']') {
        const open = ch === ')' ? '(' : '[';
        let depth = 0;
        for (; i >= 0; i--) {
          if (src[i] === ch) depth++;
          else if (src[i] === open && --depth === 0) break;
        }
        if (i < 0) return -1;
        i--;
        // What was called or indexed comes next, if anything.
        const before = i;
        skipSpace();
        if (!isWord(src[i]) && src[i] !== ')' && src[i] !== ']') return before + 1 + (src.slice(before + 1).match(/^\s*/)[0].length);
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        let open = i - 1;
        while (open >= 0 && (src[open] !== ch || src[open - 1] === '\\')) open--;
        return open;
      }
      if (!isWord(ch)) return -1;
      while (i >= 0 && isWord(src[i])) i--;
      const wordStart = i + 1;
      skipSpace();
      if (src[i] === '.') {
        i--;
        if (src[i] === '?') i--;
        continue;
      }
      return wordStart;
    }
  }

  /** mongosh shortens a long receiver expression to its first 14 and last 6 characters. */
  function shorten(text) {
    if (/^[\w$]+$/.test(text) || text.length <= 25) return text;
    return `${text.slice(0, 14)} ... ${text.slice(-6)}`;
  }

  /**
   * The source text of what was called at a "not a function" error, e.g.
   * `db.c.nope` or `db.c.find().sortt`, found from the position the engine
   * reports. Returns null when the source around it is not a plain call.
   */
  function calleeAt(error) {
    const source = msh.lastSource;
    const where = /:(\d+):(\d+)\)?\s*$/.exec(String(error.stack || '').split('\n')[0]);
    if (!source || !where) return null;
    const lines = source.split('\n');
    const lineNumber = Number(where[1]);
    if (lineNumber < 1 || lineNumber > lines.length) return null;
    let lineOffset = 0;
    for (let k = 0; k < lineNumber - 1; k++) lineOffset += lines[k].length + 1;
    const describe = (from, end) => {
      const name = source.slice(from, end);
      let dot = from - 1;
      while (dot >= 0 && /\s/.test(source[dot])) dot--;
      let start = from;
      let text = name;
      if (source[dot] === '.') {
        const optional = source[dot - 1] === '?';
        const objectEnd = optional ? dot - 1 : dot;
        start = expressionStart(source, objectEnd);
        if (start < 0) return null;
        text = `${shorten(source.slice(start, objectEnd).trim())}${optional ? '?.' : '.'}${name}`;
      }
      const constructed = /(^|[^\w$])new\s+$/.test(source.slice(0, start));
      return { text, constructed };
    };
    // Usually the reported column lands on the called name or the dot before it.
    for (const column of [Number(where[2]) - 1, Number(where[2]), Number(where[2]) - 2]) {
      let from = lineOffset + column;
      if (source[from] === '.') from++;
      if (!isWord(source[from]) || isWord(source[from - 1])) continue;
      let end = from;
      while (isWord(source[end])) end++;
      if (!/^\s*\(/.test(source.slice(end))) continue;
      return describe(from, end);
    }
    // For a call spread over several lines it lands inside the argument
    // list instead: walk back to the parenthesis that opened it.
    let depth = 0;
    const anchor = Math.min(source.length - 1, lineOffset + Number(where[2]) - 1);
    for (let i = anchor, steps = 0; i >= 0 && steps < 4000; i--, steps++) {
      const ch = source[i];
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if (ch === '[' || ch === '{') depth--;
      else if (ch === '(') {
        if (depth > 0) { depth--; continue; }
        let end = i;
        while (end > 0 && /\s/.test(source[end - 1])) end--;
        let from = end;
        while (from > 0 && isWord(source[from - 1])) from--;
        return from === end ? null : describe(from, end);
      }
      if (depth < 0) return null;
    }
    return null;
  }

  /**
   * The engine's wording for the most common runtime errors, shown the way
   * Node.js (and so mongosh) words them. Only the displayed text changes;
   * `error.message` is left as the engine produced it.
   */
  function displayMessage(error) {
    const message = String(error.message);
    if (error.name !== 'TypeError') return message;
    let match;
    if ((match = /^cannot read property '(.*)' of (undefined|null)$/.exec(message))) {
      return `Cannot read properties of ${match[2]} (reading '${match[1]}')`;
    }
    if ((match = /^cannot set property '(.*)' of (undefined|null)$/.exec(message))) {
      return `Cannot set properties of ${match[2]} (setting '${match[1]}')`;
    }
    if (message === 'not a function' || message === 'not a constructor') {
      const callee = calleeAt(error);
      if (callee) return `${callee.text} is not a ${callee.constructed || message === 'not a constructor' ? 'constructor' : 'function'}`;
    }
    return message;
  }

  function syntaxErrorPosition(error) {
    const where = /:(\d+):(\d+)/.exec(String(error.stack || ''));
    // Parser positions are shown the way mongosh shows them: (line:column),
    // with a zero-based column.
    return where ? ` (${where[1]}:${Math.max(0, Number(where[2]) - 1)})` : '';
  }

  /**
   * How an uncaught error is reported by a script (--eval, files): its name
   * and message only.
   */
  msh.formatUncaught = function (thrown) {
    const error = normalize(thrown);
    let result = `${error.name || 'Error'}: ${displayMessage(error)}`;
    if (error.name === 'SyntaxError') result += syntaxErrorPosition(error) + syntaxErrorFrame(error);
    return result;
  };

  /**
   * How an error is shown in the interactive shell, and whenever an Error is
   * the value of a line: with the server's code name and the details a
   * script would otherwise read off the error object. Like mongosh's, the
   * text starts with a carriage return.
   */
  msh.formatError = function (thrown) {
    const error = normalize(thrown);
    const colored = msh.config.colors;
    const name = error.name || 'Error';
    let result = '\r';
    result += colored ? `\u001b[1m\u001b[31m${name}\u001b[39m\u001b[22m` : name;
    if (typeof error.codeName === 'string') result += `[${error.codeName}]`;
    result += `: ${displayMessage(error)}`;
    if (name === 'SyntaxError') result += `${syntaxErrorPosition(error)}${syntaxErrorFrame(error)}\n`;
    const section = (title, value) => {
      const label = colored ? `\u001b[1m\u001b[33m${title}\u001b[39m\u001b[22m` : title;
      result += `\n${label}: ${msh.inspectForDisplay(value)}`;
    };
    if (error.errInfo) section('Additional information', error.errInfo);
    if (error.result && typeof error.result === 'object') section('Result', error.result);
    if (Array.isArray(error.writeErrors) && error.writeErrors.length) section('Write Errors', error.writeErrors);
    if (error.violations) section('Violations', error.violations);
    if (error.cause && isErrorLike(error.cause)) result += `\nCaused by: \n${msh.formatError(error.cause)}`;
    return result;
  };

  /** A thrown error as the interactive shell prints it. */
  msh.formatUncaughtInteractive = function (thrown) {
    const text = msh.formatError(thrown);
    return text.includes('\n') ? `Uncaught:\n${text}` : `Uncaught ${text}`;
  };

  msh.formatErrorJson = function (thrown) {
    const error = normalize(thrown);
    const frames = typeof error.stack === 'string' ? error.stack.replace(/\s+$/, '') : '';
    const head = `${error.name}: ${error.message}`;
    const doc = { ...error, message: error.message, stack: frames ? `${head}\n${frames}` : head, name: error.name };
    return msh.EJSON.stringify(doc, null, 2, { relaxed: msh.config.json === 'relaxed' });
  };
})(globalThis);
