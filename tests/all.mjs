#!/usr/bin/env node
// Run every test file.  Dependency-free like tests/run.mjs.
//
//   node tests/all.mjs

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = ["run.mjs", "doc.mjs"];
let failed = false;
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  try {
    execFileSync(process.execPath, [join(here, f), ...process.argv.slice(2)], { stdio: "inherit" });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
