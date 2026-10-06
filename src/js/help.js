// Shell API plumbing shared by every class: the help system, the
// "printable" protocol used when a value is the result of a line, and
// argument validation.
(function (g) {
  'use strict';

  const msh = g.__msh;
  const { asPrintable, shellApiType, inspectCustom } = msh.symbols;

  // Width of the name column, the same one `mongosh --help` uses.
  const NAME_COLUMN = 47;

  class Help {
    constructor(spec) {
      this.help = spec.help;
      this.docs = spec.docs;
      this.attr = spec.attr || [];
    }
    [asPrintable]() {
      return this;
    }
    toString() {
      return formatHelp(this);
    }
  }
  Object.defineProperty(Help.prototype, shellApiType, { value: 'Help', enumerable: false });

  function formatHelp(value) {
    const lines = [];
    const paint = (text, codes) => (msh.config.colors ? `\u001b[${codes}m${text}\u001b[0m` : text);
    if (value.help) lines.push(paint(`\n  ${value.help}:\n`, '1m\u001b[33'));
    for (const entry of value.attr) {
      if (entry.name && entry.description) {
        const head = `    ${entry.name}`;
        const [first, ...rest] = String(entry.description).split('\n');
        const pad = ' '.repeat(Math.max(1, NAME_COLUMN - head.length));
        lines.push([head + pad + first, ...rest.map((line) => ' '.repeat(NAME_COLUMN) + line)].join('\n'));
        if (entry.gap) lines.push('');
      } else if (entry.description) {
        lines.push(`  ${entry.description}`);
      }
    }
    if (value.docs) lines.push(`\n  ${paint('For more information on usage:', '1')} ${paint(value.docs, '1m\u001b[32')}`);
    return lines.join('\n');
  }
  msh.formatHelp = formatHelp;
  msh.Help = Help;

  /** A `help` function that also prints the help when evaluated bare. */
  function helpFunction(spec) {
    const help = function () {
      return new Help(spec);
    };
    Object.defineProperty(help, asPrintable, { value: () => new Help(spec), enumerable: false });
    Object.defineProperty(help, shellApiType, { value: 'Help', enumerable: false });
    Object.defineProperty(help, inspectCustom, { value: () => formatHelp(spec), enumerable: false });
    return help;
  }
  msh.helpFunction = helpFunction;

  /**
   * Register a shell API class: its type name, class-level help and one
   * description per method (which also gives each method its own `.help()`).
   */
  msh.describeClass = function (cls, { type, help, docs, prefix, methods, plain }) {
    const proto = cls.prototype;
    Object.defineProperty(proto, shellApiType, { value: type, enumerable: false, configurable: true });
    const attr = [];
    for (const [name, description] of Object.entries(methods || {})) {
      attr.push({ name, description });
      const fn = proto[name];
      if (typeof fn === 'function' && !Object.prototype.hasOwnProperty.call(fn, 'help')) {
        Object.defineProperty(fn, 'help', {
          value: helpFunction({ help: `${prefix || type}.${name}`, attr: [{ description }], docs }),
          enumerable: false,
          configurable: true,
        });
      }
    }
    Object.defineProperty(proto, 'help', { value: helpFunction({ help, docs, attr }), enumerable: false, writable: true, configurable: true });
    if (!(asPrintable in proto)) {
      Object.defineProperty(proto, asPrintable, {
        value() {
          return Array.isArray(this) ? [...this] : { ...this };
        },
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    // Nested inside another value, a shell object prints as it would alone.
    // `plain` classes (write results) are ordinary data and print as
    // `ClassName { ... }`, which is how mongosh shows them when nested.
    if (!plain && !(inspectCustom in proto)) {
      Object.defineProperty(proto, inspectCustom, {
        value() {
          return this[asPrintable]();
        },
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return cls;
  };

  /** The printable form of a value: shell objects decide their own. */
  msh.printable = function (value) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value[asPrintable] === 'function') {
      return value[asPrintable]();
    }
    return value;
  };

  msh.typeOf = function (value) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      const type = value[shellApiType];
      if (typeof type === 'string') return type;
    }
    return null;
  };

  // ------------------------------------------------------------------
  // Argument validation
  // ------------------------------------------------------------------

  /** Throw the shell's "missing argument" error for undefined arguments. */
  msh.required = function (args, count, func) {
    for (let i = 0; i < count; i++) {
      if (args[i] === undefined) {
        throw msh.invalidInput(`Missing required argument at position ${i} (${func})`);
      }
    }
  };

  /** Drop keys whose value is undefined so they are not sent as nulls. */
  msh.compact = function (object) {
    const out = {};
    for (const key of Object.keys(object)) {
      if (object[key] !== undefined) out[key] = object[key];
    }
    return out;
  };

  /** Copy the listed option keys that are present. */
  msh.pick = function (options, keys) {
    const out = {};
    if (options === null || typeof options !== 'object') return out;
    for (const key of keys) {
      if (options[key] !== undefined) out[key] = options[key];
    }
    return out;
  };

  for (const [name, cls] of Object.entries(msh.bsonClasses)) {
    const help = helpFunction({
      help: `The ${name} BSON Class`,
      docs: `https://mongodb.github.io/node-mongodb-native/Next/classes/BSON.${name}.html`,
    });
    Object.defineProperty(cls, 'help', { value: help, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(cls.prototype, 'help', { value: help, enumerable: false, writable: true, configurable: true });
  }

  for (const [alias, name] of Object.entries(msh.bsonAliases)) {
    Object.defineProperty(g[alias], 'help', { value: msh.bsonClasses[name].help, enumerable: false, writable: true, configurable: true });
  }

  msh.docs = {
    manual: 'https://mongodb.com/docs/manual/reference/method',
    shell: 'https://github.com/adaptive-scale/mongo-sh',
  };
})(globalThis);
