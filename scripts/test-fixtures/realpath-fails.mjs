// Preload for entry-realpath.test.mjs (node --import). With BANKER_TEST_REALPATH_FAILS=1, fs.realpathSync and its
// .native throw ENOENT when code calls them with process.argv[1] alone, as on a drive realpath cannot read. Node's
// own loader passes a cache option and keeps working. With BANKER_TEST_STDIN_MARK=<file>, the first use of
// process.stdin writes that file, so a hook that prints nothing still shows that its main ran.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const target = process.argv[1];

if (process.env.BANKER_TEST_REALPATH_FAILS === "1" && target) {
  const failing = (real) => function realpathSync(p, ...rest) {
    if (rest.length === 0 && String(p) === target) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}' (realpath-fails fixture)`), { code: "ENOENT" });
    }
    return real.call(this, p, ...rest);
  };
  const native = fs.realpathSync.native;
  fs.realpathSync = Object.assign(failing(fs.realpathSync), { native: failing(native) });
  syncBuiltinESMExports();
}

const mark = process.env.BANKER_TEST_STDIN_MARK;
if (mark) {
  const own = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: own.enumerable,
    get() {
      if (!fs.existsSync(mark)) fs.writeFileSync(mark, "stdin\n");
      return own.get.call(process);
    },
  });
}
