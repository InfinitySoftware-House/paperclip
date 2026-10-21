#!/usr/bin/env node
// The server runtime bundle externalizes some third-party packages by their
// absolute build-machine path, so the bundle only runs where it was built (the
// Docker image builds and runs in /app). Rewrite those paths relative to each
// file so a built tree can be unpacked anywhere.
//
// usage: node scripts/relocate-runtime-bundle.mjs <bundleDir> <buildRoot>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export function relocateSource(source, fileDir, buildRoot) {
  const root = buildRoot.replace(/\/+$/, "");
  let relative = path.posix.relative(fileDir.split(path.sep).join("/"), root) || ".";
  if (!relative.startsWith(".")) relative = `./${relative}`;
  // file:// URLs and bare absolute paths both become a relative specifier.
  return source.split(`file://${root}/`).join(`${relative}/`).split(`${root}/`).join(`${relative}/`);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(mjs|js|cjs)$/.test(name)) yield full;
  }
}

export function relocateBundle(bundleDir, buildRoot) {
  let changed = 0;
  for (const file of walk(bundleDir)) {
    const before = readFileSync(file, "utf8");
    const after = relocateSource(before, path.dirname(path.resolve(file)), path.resolve(buildRoot));
    if (after !== before) {
      writeFileSync(file, after);
      changed += 1;
    }
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const [bundleDir, buildRoot] = process.argv.slice(2);
  if (!bundleDir || !buildRoot) {
    console.error("usage: relocate-runtime-bundle.mjs <bundleDir> <buildRoot>");
    process.exit(2);
  }
  console.log(`relocated ${relocateBundle(bundleDir, buildRoot)} file(s)`);
}
