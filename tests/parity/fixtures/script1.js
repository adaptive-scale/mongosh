// Loaded as a script file: nothing is printed unless the script prints it.
const fromFile = typeof fromEval === 'undefined' ? 'no eval' : fromEval * 2;
print('script1 ran:', fromFile);
print(typeof db, db.getName().length > 0);
fromFile;
