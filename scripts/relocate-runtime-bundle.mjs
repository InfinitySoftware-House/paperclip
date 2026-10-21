#!/usr/bin/env node
// The server runtime bundle embeds the absolute build path in two ways: as
// import specifiers, and as string values (esbuild replaces `import.meta.url`
// with the original file's URL, and code resolves assets against it). Both only
// work where the bundle was built (the Docker image builds and runs in /app).
// Rewrite them so a built tree can be unpacked anywhere:
//   import specifiers   -> relative specifier
//   "file://<root>/x"   -> new URL("<rel>/x", import.meta.url).href
//   "<root>/x"          -> decoded pathname of that same URL
//
// usage: node scripts/relocate-runtime-bundle.mjs <bundleDir> <buildRoot>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param fileDir directory of the file being rewritten, posix separators */
export function relocateSource(source, fileDir, buildRoot) {
  const root = buildRoot.replace(/\/+$/, "");
  let relative = path.posix.relative(fileDir, root) || ".";
  if (!relative.startsWith(".")) relative = `./${relative}`;
  const esc = escapeRegExp(root);
  const urlOf = (rest) => `new URL(${JSON.stringify(`${relative}/${rest}`)}, import.meta.url)`;

  return source
    // 1. static and dynamic import specifiers (also file:// ones)
    .replace(
      new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])(?:file://)?${esc}/([^"']*)\\2`, "g"),
      (_match, keyword, quote, rest) => `${keyword}${quote}${relative}/${rest}${quote}`,
    )
    // 2. file:// URL strings used as values (bases for new URL, createRequire, ...)
    .replace(new RegExp(`(["'])file://${esc}/([^"']*)\\1`, "g"), (_match, _quote, rest) => `${urlOf(rest)}.href`)
    // 3. absolute filesystem paths used as values
    .replace(
      new RegExp(`(["'])${esc}/([^"']*)\\1`, "g"),
      (_match, _quote, rest) => `decodeURIComponent(${urlOf(rest)}.pathname)`,
    );
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(mjs|js|cjs)$/.test(name)) yield full;
  }
}

const posix = (value) => value.split(path.sep).join("/");

export function relocateBundle(bundleDir, buildRoot) {
  let changed = 0;
  for (const file of walk(bundleDir)) {
    const before = readFileSync(file, "utf8");
    const after = relocateSource(before, posix(path.dirname(path.resolve(file))), posix(path.resolve(buildRoot)));
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
