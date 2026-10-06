function libFn(x) {
  return { doubled: x * 2, file: typeof __filename, dir: typeof __dirname };
}
var libLoaded = true;
