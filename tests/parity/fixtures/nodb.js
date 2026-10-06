print([1, 2, 3].reduce((a, b) => a + b, 0), EJSON.stringify({ a: NumberLong('5') }));
