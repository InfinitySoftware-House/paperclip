#!/usr/bin/env node
// Fail when a relative import in the server runtime bundle points at a file
// that does not exist, which is what an unrelocated or truncated tree looks like.
// usage: node scripts/check-runtime-bundle-imports.mjs <bundleDir>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function findMissingImports(bundleDir) {
  const missing = [];
  const importPattern = /(?:\bfrom|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
  for (const name of readdirSync(bundleDir)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const source = readFileSync(path.join(bundleDir, name), "utf8");
    for (const match of source.matchAll(importPattern)) {
      if (!existsSync(path.resolve(bundleDir, match[1]))) missing.push(`${name} -> ${match[1]}`);
    }
  }
  return missing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error("usage: check-runtime-bundle-imports.mjs <bundleDir>");
    process.exit(2);
  }
  const missing = findMissingImports(bundleDir);
  if (missing.length) {
    console.error(`missing relative imports:\n${missing.join("\n")}`);
    process.exit(1);
  }
  console.log("all relative imports resolve");
}
