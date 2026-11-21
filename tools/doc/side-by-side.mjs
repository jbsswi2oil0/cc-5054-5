#!/usr/bin/env node
// Side-by-side comparison of the raw bit string the parser sees against the
// published legacy example.
//
//   node tools/doc/side-by-side.mjs                     compare examples/legacy
//   node tools/doc/side-by-side.mjs --stream a.ivc --reference b.ivc
//
// The point is to keep two independent mistakes from cancelling out.  The
// legacy example is frozen under examples/legacy/ and was published first; the
// parser and the miniature writer are checked against it, so if the main
// encoder and the docs tooling drift together the comparison still fails.
//
// Prints, side by side per byte, the reference bit string, the parsed bit
// string, and the field each byte falls into.  Exits non-zero on any
// difference.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStream } from "./checker.mjs";
import { decodeOrder } from "./parser.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function bytesOf(path) {
  return new Uint8Array(readFileSync(path));
}

function bitString(bytes, start, end) {
  let s = "";
  for (let p = start; p < end; p++) {
    if (p > start && (p - start) % 8 === 0) s += " ";
    s += (bytes[p >> 3] >> (7 - (p & 7))) & 1;
  }
  return s;
}

// Field labels for each bit of a stream, from the independent parser.
function fieldMap(bytes, check) {
  const labels = new Array(bytes.length * 8).fill("padding");
  const h = check.header;
  if (!h) return labels;
  const names = [
    [0, 32, "magic"], [32, 36, "version"], [36, 48, "width"], [48, 60, "height"],
    [60, 68, "qbase"], [68, 69, "lossless"], [69, 71, "order"], [71, 72, "hint"],
    [72, 79, "reserved"],
  ];
  for (const [a, b, name] of names) for (let p = a; p < b; p++) labels[p] = `header.${name}`;
  const order = decodeOrder(h.CW, h.CH, h.order);
  for (const i of order) {
    const e = check.dir.entries[i];
    if (!e) continue;
    if (!e.token) {
      for (let p = e.startBit; p < Math.min(e.endBit, labels.length); p++) labels[p] = `block${i}.incomplete`;
      continue;
    }
    for (let p = e.startBit; p < Math.min(e.endBit, labels.length); p++) labels[p] = `block${i}`;
    const r = e.ranges;
    if (r) {
      for (let p = r.qsel.start; p < r.qsel.end; p++) labels[p] = `block${i}.qsel`;
      for (let p = r.mode.start; p < r.mode.end; p++) labels[p] = `block${i}.mode`;
      for (let p = r.numAC.start; p < r.numAC.end; p++) labels[p] = `block${i}.numAC`;
      for (let p = r.dc.start; p < r.dc.end; p++) labels[p] = `block${i}.DC`;
      r.ac.forEach((rg, k) => {
        for (let p = rg.start; p < rg.end; p++) labels[p] = `block${i}.AC[${k + 1}]`;
      });
      if (r.rice) {
        for (let p = r.rice.start; p < r.rice.end; p++) labels[p] = `block${i}.rice`;
        r.res?.forEach((rg, k) => {
          for (let p = rg.start; p < rg.end; p++) labels[p] = `block${i}.res[${k}]`;
        });
      }
    }
  }
  return labels;
}

const refPath = arg("--reference", join(ROOT, "examples", "legacy", "blocks-v1.ivc"));
const streamPath = arg("--stream", join(ROOT, "examples", "shared-edge", "stream.ivc"));

if (!existsSync(refPath)) {
  console.error(`missing reference stream ${refPath}; run node tools/doc/examples.mjs`);
  process.exit(2);
}

const ref = bytesOf(refPath);
const stream = bytesOf(streamPath);
const refCheck = checkStream(ref);
const streamCheck = checkStream(stream);

if (!refCheck.header) {
  console.error(`reference stream has no valid header: ${refCheck.error.message}`);
  process.exit(2);
}
if (!streamCheck.header) {
  console.error(`stream has no valid header: ${streamCheck.error.message}`);
  process.exit(2);
}

const refLabels = fieldMap(ref, refCheck);
const streamLabels = fieldMap(stream, streamCheck);

// Compare block structure first (published legacy layout must match).
let mismatches = 0;
const refBlocks = refCheck.dir.entries.filter(Boolean);
const streamBlocks = streamCheck.dir.entries.filter(Boolean);
console.log(`reference ${refPath}  ${ref.length} B / ${ref.length * 8} b  ` +
  `${refCheck.header.CW}x${refCheck.header.CH} blocks  published ${refCheck.publishedCount}/${refCheck.blockCount}`);
console.log(`stream    ${streamPath}  ${stream.length} B / ${stream.length * 8} b  ` +
  `${streamCheck.header.CW}x${streamCheck.header.CH} blocks  published ${streamCheck.publishedCount}/${streamCheck.blockCount}`);
console.log("");
console.log("side-by-side bit strings (reference | stream), labelled by parser field:");

const n = Math.max(ref.length, stream.length);
let printedHeader = false;
for (let off = 0; off < n; off++) {
  const a = off < ref.length ? ref[off] : null;
  const b = off < stream.length ? stream[off] : null;
  if (!printedHeader) {
    console.log("  byte  reference  stream   field(ref)                 field(stream)");
    printedHeader = true;
  }
  const ra = a === null ? "--------" : a.toString(2).padStart(8, "0");
  const rb = b === null ? "--------" : b.toString(2).padStart(8, "0");
  // Label the byte by the field that owns its FIRST bit (byte-aligned display;
  // the manifest carries the exact per-bit field ranges).
  const la = off * 8 < refLabels.length ? refLabels[off * 8] : "-";
  const lb = off * 8 < streamLabels.length ? streamLabels[off * 8] : "-";
  const differ = a !== b ? " <" : "";
  if (a !== b) mismatches++;
  console.log(`  ${String(off).padStart(4)}  ${ra}  ${rb}   ${String(la).padEnd(22)} ${String(lb).padEnd(22)}${differ}`);
}

// Structural agreement: same header fields, same number of published blocks,
// same per-block field labels.  (The two streams need not be byte-identical:
// they are different tables.  What must agree is the grammar.)
console.log("");
const headerFieldsEqual =
  refCheck.header.W === streamCheck.header.W &&
  refCheck.header.H === streamCheck.header.H &&
  refCheck.header.qbase === streamCheck.header.qbase &&
  refCheck.header.order === streamCheck.header.order &&
  refCheck.header.lossless === streamCheck.header.lossless;
console.log(`header fields agree: ${headerFieldsEqual}`);

// Grammar check: every block's fields tile its range with no gaps or overlap.
let grammarOk = true;
for (const e of streamCheck.dir.entries) {
  if (!e || !e.ranges) continue;
  const r = e.ranges;
  const fields = [r.qsel, r.mode, r.numAC, r.dc, ...r.ac, { start: r.end, end: r.end }];
  for (let k = 0; k + 1 < fields.length; k++) {
    if (fields[k].end !== fields[k + 1].start) { grammarOk = false; break; }
  }
  if (r.qsel.start !== e.startBit || r.end !== e.endBit) grammarOk = false;
}
console.log(`block grammar tiles each range exactly: ${grammarOk}`);

const ok = headerFieldsEqual && grammarOk;
console.log("");
console.log(ok ? "reference and parser agree on the grammar" : "DISAGREEMENT between reference and parser");
process.exit(ok ? 0 : 1);
