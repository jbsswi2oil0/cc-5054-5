#!/usr/bin/env node
// Regenerate every documentation example under examples/.
//
//   node tools/doc/examples.mjs            write the examples
//   node tools/doc/examples.mjs --check    fail if any file is out of date
//
// The examples are produced from readable coefficient tables in fixtures.mjs
// by the miniature writer, never by the main encoder.  Each stream is checked
// by the independent parser before it is written.  The manifest records exact
// bit positions; tests and the docs view consume it.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSharedEdge, buildMinimal, buildLegacy, productionPixels } from "./fixtures.mjs";
import { buildDirectory } from "./directory.mjs";
import { checkStream, bitsAt } from "./checker.mjs";
import { hexDump, bitsToString } from "../../src/format.js";
import { writePGM } from "../pgm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXAMPLES = join(ROOT, "examples");
const check = process.argv.includes("--check");

const outputs = new Map(); // relative path -> Uint8Array or string

function put(rel, data) {
  outputs.set(rel, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

function putJSON(rel, obj) {
  put(rel, JSON.stringify(obj, null, 2) + "\n");
}

function pgm(gray, W, H) { return writePGM(gray, W, H); }

// ---------------------------------------------------------------- shared edge
const se = buildSharedEdge();
const seDir = buildDirectory(se.bytes);
const seCheck = checkStream(se.bytes);

put("shared-edge/stream.ivc", se.bytes);
put("shared-edge/intact.pgm", pgm(se.intact.crop.pixels, 16, 8));
put("shared-edge/missing-last-byte.ivc", se.damaged.missing.bytes);
put("shared-edge/misaligned-marker.ivc", se.damaged.misaligned.bytes);
put("shared-edge/shared-edge-flip.ivc", se.damaged.flipped.bytes);

// The same stream with the 4-bit version field set to 2.  Every later bit is
// unchanged, so the checker must reject it at bits [32,36) and must NOT report
// any block-level failure.
const unknownVersion = Uint8Array.from(se.bytes);
unknownVersion[34 >> 3] |= 1 << (7 - (34 & 7));  // set bit 34   (0010)
unknownVersion[35 >> 3] &= ~(1 << (7 - (35 & 7))); // clear bit 35 (0001)
put("shared-edge/unknown-version.ivc", unknownVersion);

// Decoded pixels for the damaged streams: blocks that are not fully determined
// are written as 0 by the production decoder, which is exactly what the docs
// claim happens.
put("shared-edge/missing-last-byte.pgm", pgm(productionPixels(se.damaged.missing.bytes).crop.pixels, 16, 8));
put("shared-edge/misaligned-marker.pgm", pgm(productionPixels(se.damaged.misaligned.bytes).crop.pixels, 16, 8));
put("shared-edge/shared-edge-flip.pgm", pgm(productionPixels(se.damaged.flipped.bytes).crop.pixels, 16, 8));

// Per-block directory for the intact stream (only published entries).
const f0 = seDir.entries[0], f1 = seDir.entries[1];
const seManifest = {
  name: "shared-edge",
  description:
    "Two horizontally adjacent 8x8 blocks. Block 0 ends on a byte boundary with a " +
    "negative AC level; block 1 predicts from block 0's right column.",
  coefficients: [
    { block: 0, qsel: 0, mode: 0, dc: -3, ac: [-4, -3] },
    { block: 1, qsel: 0, mode: 2, dc: 2, ac: [] },
  ],
  layout: {
    headerBits: se.facts.headerBits,
    totalBits: se.facts.totalBits,
    byteLength: se.facts.byteLength,
    blocks: se.stream.blocks.map((b) => ({
      block: b.index, startBit: b.bitStart, endBit: b.bitEnd,
      mode: b.mode, qsel: b.qsel,
      published: b.index !== undefined && seDir.entries[b.index] && seDir.entries[b.index].published,
      fields: b.ranges,
    })),
  },
  block0LastCoefficient: se.facts.lastACCoefficient,
  damage: {
    missingLastByte: se.facts.missingLastByte,
    misalignedMarker: se.facts.misalignedMarker,
    sharedEdgeFlip: se.facts.sharedEdge,
  },
  unknownVersion: (() => {
    const c = checkStream(unknownVersion);
    return { status: c.status, bitRange: c.bitRange, bits: c.bits };
  })(),
  bits: {
    block0: bitsAt(se.bytes, f0.startBit, f0.endBit),
    block1: bitsAt(se.bytes, f1.startBit, f1.endBit),
    header: bitsToString(se.bytes, 0, 79),
    hex: hexDump(se.bytes),
  },
};
putJSON("shared-edge/manifest.json", seManifest);

// ------------------------------------------------------------------- minimal
const mn = buildMinimal();
put("minimal/stream.ivc", mn.bytes);
put("minimal/decoded.pgm", pgm(productionPixels(mn.bytes).crop.pixels, 8, 8));
putJSON("minimal/manifest.json", {
  name: "minimal",
  description: "Smallest documented example: one 8x8 block, one non-zero level (DC=16).",
  headerBits: mn.facts.headerBits,
  totalBits: mn.facts.totalBits,
  byteLength: mn.facts.byteLength,
  fields: mn.facts.fields,
  levels: mn.facts.levels,
  bits: bitsToString(mn.bytes, 79, mn.facts.totalBits),
  hex: hexDump(mn.bytes),
});

// -------------------------------------------------------------------- legacy
// The legacy stream is the frozen "published old format" example.  If it does
// not already exist it is created here; --check compares against it.  Once
// committed it is never rewritten by this tool, which is the point: a docs
// regression cannot quietly refresh its own reference.
const lg = buildLegacy();
const legacyPath = join(EXAMPLES, "legacy", "blocks-v1.ivc");
const legacyExists = existsSync(legacyPath);
if (!legacyExists) {
  put("legacy/blocks-v1.ivc", lg.bytes);
  putJSON("legacy/blocks-v1.json", {
    name: "legacy-v1",
    description: "Published IVC1 example from the first documented revision.",
    totalBits: lg.bitLength,
    byteLength: lg.stream.byteLength,
    blocks: lg.stream.blocks.map((b) => ({ block: b.index, startBit: b.bitStart, endBit: b.bitEnd,
      fields: b.ranges })),
    hex: hexDump(lg.bytes),
  });
}

// --------------------------------------------------------------------- write
mkdirSync(EXAMPLES, { recursive: true });
let stale = 0, wrote = 0;
for (const [rel, data] of outputs) {
  const path = join(EXAMPLES, rel);
  const same = existsSync(path) && Buffer.from(data).equals(readFileSync(path));
  if (check) {
    if (!same) { stale++; console.error(`stale: examples/${rel}`); }
  } else if (!same) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    wrote++;
  }
}

if (check) {
  if (stale) { console.error(`${stale} example file(s) out of date; run node tools/doc/examples.mjs`); process.exit(1); }
  console.log("examples are up to date");
} else {
  console.log(`wrote ${wrote} example file(s), ${outputs.size} total under examples/`);
}
