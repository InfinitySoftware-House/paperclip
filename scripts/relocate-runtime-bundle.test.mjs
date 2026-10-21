import { test } from "node:test";
import assert from "node:assert/strict";
import { relocateSource } from "./relocate-runtime-bundle.mjs";

const root = "/home/runner/work/paperclip/paperclip";
const dir = `${root}/server/dist-runtime`;
const installed = { url: "file:///opt/app/server/dist-runtime/chunk.mjs" };
const evaluate = (expression) =>
  new Function("importMeta", `return ${expression.replace(/import\.meta\.url/g, "importMeta.url")}`)(installed);

test("import specifiers become relative", () => {
  const out = relocateSource(`import x from "${root}/node_modules/pkg/index.js"; await import("${root}/a.js");`, dir, root);
  assert.equal(out, `import x from "../../node_modules/pkg/index.js"; await import("../../a.js");`);
});

test("a file:// base resolves against the install location, not the build machine", () => {
  const out = relocateSource(`"file://${root}/server/dist/build-commit.js"`, dir, root);
  assert.equal(evaluate(out).href ?? evaluate(out), "file:///opt/app/server/dist/build-commit.js");
  const info = evaluate(`new URL("./build-info.json", ${out}).href`);
  assert.equal(info, "file:///opt/app/server/dist/build-info.json");
});

test("an absolute path value stays an absolute path at the install location", () => {
  const out = relocateSource(`"${root}/packages/x.ts"`, dir, root);
  assert.equal(evaluate(out), "/opt/app/packages/x.ts");
});

test("a relative string is never produced where a URL or absolute path is required", () => {
  const out = relocateSource(
    `new URL("./a.json", "file://${root}/server/dist/x.js"); createRequire("${root}/p/q.ts");`,
    dir,
    root,
  );
  assert.ok(!/new URL\("\.\/a\.json", "\.\.\//.test(out));
  assert.ok(!/createRequire\("\.\.\//.test(out));
});

test("nested files get a longer relative prefix", () => {
  const out = relocateSource(`import q from "${root}/node_modules/q.js"`, `${dir}/sub`, root);
  assert.equal(out, `import q from "../../../node_modules/q.js"`);
});

test("source without build paths is untouched", () => {
  const source = `import fs from "node:fs"; const x = "/usr/bin/env";`;
  assert.equal(relocateSource(source, dir, root), source);
});
