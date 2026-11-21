#!/usr/bin/env node
// Bit-position checker front end.
//
//   node tools/doc/check.mjs check <stream.ivc> [--bits N]
//   node tools/doc/check.mjs lookup <stream.ivc> <x> <y> [--bits N] [--reference intact.pgm]
//   node tools/doc/check.mjs explain <damaged.ivc> <intact.ivc> <x> <y>
//   node tools/doc/check.mjs directory <stream.ivc> [--json]
//   node tools/doc/check.mjs seek <stream.ivc> <block>
//
// `check` prints the status (valid, truncated, unknown-version, bad-header),
// the exact bit range of a rejected header field, and the failure bit of a
// truncated block.  `lookup` walks a pixel back to the coefficients and the
// exact bits that carried them.  `explain` attributes a wrong pixel in a
// damaged stream to the field of the intact stream that was disturbed.

import { readFileSync } from "node:fs";
import { checkStream, lookupPixel, explainPixel } from "./checker.mjs";
import { buildDirectory, seekBlock, seekDirectory } from "./directory.mjs";

function args() { return process.argv.slice(3); }
function flag(name) { return process.argv.includes(name); }
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const cmd = process.argv[2];
const rest = args();

function read(path) { return new Uint8Array(readFileSync(path)); }
function bitLenOf(bytes) {
  const b = argVal("--bits");
  return b ? Number(b) : bytes.length * 8;
}

if (cmd === "check") {
  const bytes = read(rest[0]);
  const result = checkStream(bytes, { bitLen: bitLenOf(bytes) });
  console.log(`status: ${result.status}`);
  if (result.error) {
    console.log(`error: ${result.error.message}`);
    console.log(`bit range: [${result.bitRange.start},${result.bitRange.end}) = "${result.bits}"`);
  } else {
    console.log(`header: ${result.header.W}x${result.header.H} qbase=${result.header.qbase} ` +
      `order=${result.header.order}${result.header.lossless ? " lossless" : ""}`);
    console.log(`blocks: ${result.publishedCount}/${result.blockCount} published ` +
      `of ${result.bitLength} available bits`);
    if (result.failure) {
      console.log(`failure: block ${result.failure.index} at bit ${result.failure.bitPos} ` +
        `(${result.failure.reason})`);
      if (result.failure.bits) console.log(`  bits: "${result.failure.bits}"`);
    }
  }
  process.exit(result.status === "valid" ? 0 : 1);
} else if (cmd === "lookup") {
  const [path, x, y] = rest;
  const bytes = read(path);
  const reference = argVal("--reference");
  let ref = null;
  if (reference) {
    // PGM payload only; 8-bit P5 with a short ASCII header.
    const buf = readFileSync(reference);
    let i = 0, nl = 0;
    while (nl < 3 && i < buf.length) { if (buf[i] === 10) nl++; i++; }
    ref = buf.slice(i);
  }
  const r = lookupPixel(bytes, Number(x), Number(y), { bitLen: bitLenOf(bytes), reference: ref });
  console.log(JSON.stringify(r, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v), 2));
} else if (cmd === "explain") {
  const [dmg, intact, x, y] = rest;
  const d = read(dmg), r = read(intact);
  const out = explainPixel(d, bitLenOf(d), r, Number(x), Number(y));
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "directory") {
  const bytes = read(rest[0]);
  const dir = buildDirectory(bytes, { bitLen: bitLenOf(bytes) });
  console.log(JSON.stringify(seekDirectory(dir), null, 2));
} else if (cmd === "seek") {
  const bytes = read(rest[0]);
  const dir = buildDirectory(bytes, { bitLen: bitLenOf(bytes) });
  try {
    const r = seekBlock(bytes, dir, Number(rest[1]));
    console.log(JSON.stringify({ block: Number(rest[1]), bitStart: r.bitStart, bitEnd: r.bitEnd,
      mode: r.token.mode, qsel: r.token.qsel ?? 0, numAC: r.token.numAC ?? 64,
      levels: Array.from(r.token.levels.slice(0, r.token.numAC ?? 64)),
      bytesTouched: r.bytesTouched }, null, 2));
  } catch (e) {
    console.error(`refused: ${e.message}`);
    process.exit(1);
  }
} else {
  console.log(`usage:
  node tools/doc/check.mjs check <stream.ivc> [--bits N]
  node tools/doc/check.mjs lookup <stream.ivc> <x> <y> [--bits N] [--reference intact.pgm]
  node tools/doc/check.mjs explain <damaged.ivc> <intact.ivc> <x> <y>
  node tools/doc/check.mjs directory <stream.ivc>
  node tools/doc/check.mjs seek <stream.ivc> <block>`);
  process.exit(cmd ? 2 : 0);
}
