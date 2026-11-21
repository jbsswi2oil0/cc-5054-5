#!/usr/bin/env node
// Tests for the documentation / experiment tooling.
//
//   node tests/doc.mjs            run
//   node tests/doc.mjs --verbose  print each assertion
//
// These tests exercise the independent parser and the miniature writer, and
// deliberately avoid src/encode.js for fixture construction.  The production
// decoder is used only as the independent cross-check the directory requires.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTable, writeStream, flatBlock, validateTable, blockBitLength } from "../tools/doc/miniwriter.mjs";
import { buildDirectory, seekDirectory, seekBlock } from "../tools/doc/directory.mjs";
import { checkStream, lookupPixel, explainPixel, bitsAt } from "../tools/doc/checker.mjs";
import { dropTailBits, deleteBit, flipBit, packBits, bitsOf } from "../tools/doc/faults.mjs";
import { buildSharedEdge, buildMinimal, buildLegacy, sharedEdgeTable, legacyTable } from "../tools/doc/fixtures.mjs";
import { decode, cropToImage } from "../src/decode.js";
import { writePGM } from "../tools/pgm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; if (verbose) console.log(`  ok  ${name}`); }
  catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL ${name}\n        ${e.message.split("\n")[0]}`); }
}

const readExample = (p) => new Uint8Array(readFileSync(join(ROOT, "examples", p)));

// ------------------------------------------------------- miniature writer
console.log("miniature writer");

test("writer produces a stream the production decoder accepts", () => {
  const s = writeStream(sharedEdgeTable());
  const d = decode(s.bytes);
  assert.ok(d.ok, d.reason);
  assert.equal(d.completeBlocks, 2);
  assert.equal(d.bitPos, s.totalBits);
});

test("writer's bit ranges match what the production decoder reports", () => {
  const s = writeStream(sharedEdgeTable());
  const d = decode(s.bytes);
  for (const b of s.blocks) {
    assert.equal(d.blocks[b.index].bitStart, b.bitStart, `block ${b.index} start`);
    assert.equal(d.blocks[b.index].bitEnd, b.bitEnd, `block ${b.index} end`);
  }
});

test("readable table round-trips through the parser", () => {
  for (const table of [sharedEdgeTable(), legacyTable(), makeTable({ W: 8, H: 8 }, [flatBlock(128)])]) {
    const s = writeStream(table);
    const dir = buildDirectory(s.bytes);
    assert.ok(dir.header);
    for (const b of s.blocks) {
      assert.ok(dir.entries[b.index].token, `block ${b.index} token`);
      assert.equal(dir.entries[b.index].published, true, `block ${b.index} published`);
    }
  }
});

test("writer rejects an out-of-range table before writing", () => {
  assert.throws(() => validateTable(makeTable({ W: 8, H: 8 }, [{ qsel: 9, mode: 0, dc: 0, ac: [] }])), /qsel/);
  assert.throws(() => validateTable(makeTable({ W: 8, H: 8 }, [{ qsel: 0, mode: 7, dc: 0, ac: [] }])), /mode/);
  assert.throws(() => validateTable(makeTable({ W: 8, H: 8 }, [{ qsel: 0, mode: 0, dc: 0.5, ac: [] }])), /integer/);
});

test("blockBitLength agrees with the written length", () => {
  const s = writeStream(sharedEdgeTable());
  const t = validateTable(sharedEdgeTable());
  for (let i = 0; i < s.blocks.length; i++) {
    assert.equal(blockBitLength(t.blocks[i]), s.blocks[i].bitEnd - s.blocks[i].bitStart, `block ${i}`);
  }
});

// ------------------------------------------------------------- directory
console.log("directory");

test("every verified block is published with exact bit spans", () => {
  const s = writeStream(sharedEdgeTable());
  const dir = buildDirectory(s.bytes);
  assert.deepEqual(dir.published, [0, 1]);
  for (const i of dir.published) {
    const e = dir.entries[i];
    const d = decode(s.bytes);
    assert.equal(d.blocks[i].bitStart, e.startBit);
    assert.equal(d.blocks[i].bitEnd, e.endBit);
  }
});

test("a truncated tail is locatable but never published", () => {
  const s = writeStream(sharedEdgeTable());
  const cut = dropTailBits(s.bytes, s.totalBits, 6);
  const dir = buildDirectory(cut.bytes, { bitLen: cut.bitLength });
  assert.deepEqual(dir.published, [0]);
  assert.equal(dir.entries[1].published, false);
  assert.equal(dir.entries[1].locatable, true);
  assert.equal(dir.entries[1].startBit, s.blocks[1].bitStart);
  assert.ok(dir.entries[1].checks.reasons.length > 0);
});

test("seek reads only a published block, at its exact range", () => {
  const s = writeStream(sharedEdgeTable());
  const dir = buildDirectory(s.bytes);
  const a = seekBlock(s.bytes, dir, 0);
  assert.equal(a.bitStart, s.blocks[0].bitStart);
  assert.equal(a.bitEnd, s.blocks[0].bitEnd);
  assert.deepEqual(Array.from(a.token.levels.slice(0, a.token.numAC)), [-3, -4, -3]);
  // seeks do not depend on earlier blocks: reading block 1 touches only the
  // bytes covering block 1.
  const b = seekBlock(s.bytes, dir, 1);
  assert.ok(b.bytesTouched.firstByte >= (s.blocks[1].bitStart >> 3));
});

test("seek refuses an unpublished block", () => {
  const s = writeStream(sharedEdgeTable());
  const cut = dropTailBits(s.bytes, s.totalBits, 6);
  const dir = buildDirectory(cut.bytes, { bitLen: cut.bitLength });
  assert.throws(() => seekBlock(cut.bytes, dir, 1), /not published/);
});

test("a published prefix block still yields its correct pixels when the tail is damaged", () => {
  const se = buildSharedEdge();
  // Intact block 0 pixels in the target window.
  const intactPix = cropToImage(decode(se.bytes)).pixels;
  const damaged = se.damaged.missing.bytes;
  const cutDir = buildDirectory(damaged);
  assert.deepEqual(cutDir.published, [0], "only block 0 is published");
  // Random-access the published prefix block and reconstruct it.
  const rec = seekBlock(damaged, cutDir, 0);
  assert.deepEqual(Array.from(rec.token.levels.slice(0, rec.token.numAC)), [-3, -4, -3]);
  // The production decoder agrees on the prefix block.
  const d = decode(damaged);
  const crop = cropToImage(d);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) assert.equal(crop.pixels[y * 16 + x], intactPix[y * 16 + x], `pixel ${x},${y}`);
  }
  assert.equal(crop.valid[0], 1, "block 0 is displayed");
  assert.equal(crop.valid[8], 0, "block 1 is not displayed");
});

test("the damaged tail is still locatable (its start bit is known)", () => {
  const se = buildSharedEdge();
  const dir = buildDirectory(se.damaged.missing.bytes);
  assert.equal(dir.entries[1].locatable, true);
  assert.equal(dir.entries[1].startBit, se.facts.block1.startBit);
  assert.equal(dir.entries[1].published, false);
});

test("the published directory is enough for random access", () => {
  const s = writeStream(sharedEdgeTable());
  const dir = buildDirectory(s.bytes);
  const sd = seekDirectory(dir);
  assert.equal(sd.complete, true);
  assert.equal(sd.publishedCount, 2);
  for (const e of sd.entries) {
    const r = seekBlock(s.bytes, dir, e.block);
    assert.equal(r.bitStart, e.startBit);
    assert.equal(r.bitEnd, e.endBit);
  }
});

// -------------------------------------------------------- truncation pair
console.log("truncation");

test("a lost last byte reports inside the final block", () => {
  const se = buildSharedEdge();
  const m = se.facts.missingLastByte;
  assert.equal(m.status, "truncated");
  assert.equal(m.byteCount, se.facts.byteLength - 1);
  assert.equal(m.failureIndex, 1);
  // the failure is genuinely inside block 1, before the stored end
  assert.ok(m.failureBit >= se.facts.block1.startBit);
  assert.ok(m.failureBit < se.facts.block1.endBit);
});

test("a byte-complete stream with a misplaced end marker fails elsewhere", () => {
  const se = buildSharedEdge();
  const m = se.facts.missingLastByte;
  const a = se.facts.misalignedMarker;
  // same byte count as the intact stream
  assert.equal(a.byteCount, se.facts.byteLength);
  assert.equal(a.status, "truncated");
  // and a different reported bit from the true byte loss
  assert.notEqual(a.failureBit, m.failureBit);
  // the misplaced marker is detected at the stored end, not inside the block
  assert.equal(a.failureBit, se.byteLength * 8);
  assert.ok(m.failureBit < se.byteLength * 8);
});

test("the damaged tails are produced from bit ops, not byte truncation", () => {
  const se = buildSharedEdge();
  assert.equal(se.damaged.missing.bitLength, se.facts.totalBits - 8);
  assert.equal(se.damaged.misaligned.bitLength, se.facts.byteLength * 8);
  assert.equal(se.damaged.misaligned.bytes.length, se.facts.byteLength);
});

// ------------------------------------------------------- shared-edge flip
console.log("shared-edge propagation");

test("one flipped bit leaves the neighbour's payload intact but changes its pixels", () => {
  const se = buildSharedEdge();
  const f = se.facts.sharedEdge;
  assert.equal(f.block1TokenUnchanged, true, "block 1 codewords must be untouched");
  assert.equal(f.block1RangeUnchanged, true, "block 1 bit range must be untouched");
  assert.equal(f.decodeStillOk, true, "the stream is still structurally valid");
  assert.ok(f.wrongPixel, "a pixel in block 1 must be wrong");
  assert.notEqual(f.wrongPixel.intact, f.wrongPixel.flipped);
  assert.equal(f.firstDifferenceBit, f.flippedBit);
  assert.equal(f.sourceBlock, 0, "the fault is in block 0");
});

test("the negative, byte-aligned coefficient is the last written codeword", () => {
  const se = buildSharedEdge();
  const c = se.facts.lastACCoefficient;
  assert.ok(c.level < 0, "the last AC level is negative");
  assert.equal(c.bitRange.end, se.facts.block0.endBit);
  assert.equal(se.facts.block0.byteAligned, true);
  // and it is the final codeword of the block
  const e0 = buildDirectory(se.bytes).entries[0];
  assert.equal(e0.ranges.ac[e0.ranges.ac.length - 1].end, se.facts.block0.endBit);
});

// ----------------------------------------------------- checker three modes
console.log("checker");

test("valid stream: every block published", () => {
  const bytes = readExample("shared-edge/stream.ivc");
  const c = checkStream(bytes);
  assert.equal(c.status, "valid");
  assert.equal(c.publishedCount, c.blockCount);
  assert.equal(c.failure, null);
});

test("unknown version: rejected at the version field, no block failure", () => {
  const bytes = readExample("shared-edge/unknown-version.ivc");
  const c = checkStream(bytes);
  assert.equal(c.status, "unknown-version");
  assert.deepEqual(c.bitRange, { start: 32, end: 36 });
  assert.equal(c.bits, "0010");
  assert.equal(c.failure, undefined);
  assert.equal(c.published, undefined);
});

test("truncated stream: exact failure bit and only verified prefix published", () => {
  const bytes = readExample("shared-edge/missing-last-byte.ivc");
  const c = checkStream(bytes);
  assert.equal(c.status, "truncated");
  assert.equal(c.failure.index, 1);
  assert.equal(c.failure.bitPos, 120);
  assert.deepEqual(c.published, [0]);
});

test("checker and production decoder agree on every published block", () => {
  for (const f of ["shared-edge/stream.ivc", "minimal/stream.ivc"]) {
    const bytes = readExample(f);
    const dir = buildDirectory(bytes);
    const d = decode(bytes);
    for (const i of dir.published) assert.equal(d.blocks[i].bitStart, dir.entries[i].startBit, `${f} block ${i}`);
    for (const i of dir.published) assert.equal(d.blocks[i].bitEnd, dir.entries[i].endBit, `${f} block ${i}`);
  }
});

// -------------------------------------------------------- reverse lookup
console.log("reverse lookup");

test("a pixel resolves to the coefficient and the exact bit range that carried it", () => {
  const bytes = readExample("shared-edge/stream.ivc");
  const r = lookupPixel(bytes, 8, 0);
  assert.equal(r.pixel.block, 1);
  assert.ok(r.contributor, "a contributing coefficient is identified");
  // block 1 has only DC, carried by bits [118,123)
  assert.equal(r.contributor.bits.start, 118);
  assert.equal(r.contributor.bits.end, 123);
  assert.equal(r.blockEntry.startBit, 112);
  assert.equal(r.blockEntry.endBit, 123);
});

test("a pixel in block 0 resolves to a transmitted AC coefficient of that block", () => {
  const bytes = readExample("shared-edge/stream.ivc");
  const r = lookupPixel(bytes, 7, 3);
  assert.equal(r.pixel.block, 0);
  assert.ok(r.contributor);
  // the contributor's bits are one of block 0's AC codewords
  assert.equal(r.contributor.bits.start, 96);
  assert.equal(r.contributor.bits.end, 105);
  const bits = r.coefficients.find((c) => c.z === r.contributor.z).bits;
  assert.deepEqual(bits, { start: 96, end: 105 });
  // the block as a whole still spans through the byte-aligned end
  assert.equal(r.blockEntry.endBit, 112);
});

test("lookup rejects a pixel outside the image window", () => {
  const bytes = readExample("shared-edge/stream.ivc");
  assert.ok(lookupPixel(bytes, 16, 0).error);
  assert.ok(lookupPixel(bytes, 0, 8).error);
});

test("explain traces a wrong pixel to the disturbed field of the intact stream", () => {
  const damaged = readExample("shared-edge/shared-edge-flip.ivc");
  const intact = readExample("shared-edge/stream.ivc");
  const x = explainPixel(damaged, damaged.length * 8, intact, 8, 0);
  assert.equal(x.correct, false);
  assert.equal(x.firstDifferenceBit, 109);
  assert.equal(x.source.kind, "block");
  assert.equal(x.source.block, 0);
  assert.equal(x.source.field, "AC");
  assert.equal(x.coefficient.z, 2);
  assert.equal(x.coefficient.level, -3);
  assert.deepEqual(x.coefficient.bitRange, { start: 105, end: 112 });
});

// ------------------------------------------------------------- examples
console.log("examples");

test("generated examples are up to date", () => {
  execFileSync(process.execPath, [join(ROOT, "tools/doc/examples.mjs"), "--check"], { stdio: "pipe" });
});

test("every example stream is reported by the checker as documented", () => {
  const cases = {
    "shared-edge/stream.ivc": "valid",
    "shared-edge/unknown-version.ivc": "unknown-version",
    "shared-edge/missing-last-byte.ivc": "truncated",
    "shared-edge/misaligned-marker.ivc": "truncated",
    "shared-edge/shared-edge-flip.ivc": "valid",
    "minimal/stream.ivc": "valid",
    "legacy/blocks-v1.ivc": "valid",
  };
  for (const [f, status] of Object.entries(cases)) {
    assert.equal(checkStream(readExample(f)).status, status, f);
  }
});

test("the legacy example is frozen and matches a fresh write", () => {
  const fresh = buildLegacy();
  const frozen = readExample("legacy/blocks-v1.ivc");
  assert.deepEqual(Array.from(frozen), Array.from(fresh.bytes),
    "examples/legacy/blocks-v1.ivc must not change");
});

test("side-by-side comparison agrees with the published legacy grammar", () => {
  execFileSync(process.execPath, [join(ROOT, "tools/doc/side-by-side.mjs")], { stdio: "pipe" });
});

// ---------------------------------------------------------- quantiser
console.log("quantiser");

test("rebuilding after a quantiser change reports old-decoder behaviour", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivc-q-"));
  const newQ = join(dir, "new.json"), oldQ = join(dir, "old.json");
  const base = [[16, 16, 16, 16, 17, 18, 21, 24], [16, 16, 16, 16, 17, 19, 22, 25],
    [16, 16, 17, 17, 18, 20, 24, 28], [16, 16, 17, 18, 19, 22, 26, 31],
    [17, 17, 18, 19, 21, 24, 29, 35], [18, 19, 20, 22, 24, 28, 34, 41],
    [21, 22, 24, 26, 29, 34, 42, 50], [24, 25, 28, 31, 35, 41, 50, 60]];
  writeFileSync(oldQ, JSON.stringify({ QM: base, QSEL_MULT: [10, 13, 16, 22] }));
  writeFileSync(newQ, JSON.stringify({ QM: base, QSEL_MULT: [12, 15, 18, 24] }));
  const out = execFileSync(process.execPath, [
    join(ROOT, "tools/doc/quantiser.mjs"), "--table", newQ, "--diff", oldQ,
  ], { stdio: "pipe" }).toString();
  const report = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1));
  assert.ok(report.samples["shared-edge"], "shared-edge sample reported");
  assert.equal(typeof report.samples["shared-edge"].oldDecoderOnNewStream.samePixelsAsOriginal, "boolean");
  assert.equal(report.samples["shared-edge"].lengthChanged, true, "changed steps alter the coded length");
});

test("quantiser tool without changes is pixel-neutral", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "tools/doc/quantiser.mjs")], { stdio: "pipe" }).toString();
  const report = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1));
  for (const name of Object.keys(report.samples)) {
    assert.equal(report.samples[name].oldDecoderOnNewStream.samePixelsAsOriginal, true, name);
    assert.equal(report.samples[name].newDecoderOnNewStream.samePixelsAsOriginal, true, name);
    assert.equal(report.samples[name].lengthChanged, false, name);
  }
});

// ------------------------------------------------------- python cross-check
console.log("cross-implementation");

test("the independent Python decoder reads a miniature-writer stream", () => {
  const s = writeStream(sharedEdgeTable());
  const dir = mkdtempSync(join(tmpdir(), "ivc-doc-"));
  const ivc = join(dir, "a.ivc"), jsPgm = join(dir, "js.pgm"), pyPgm = join(dir, "py.pgm");
  writeFileSync(ivc, s.bytes);
  const d = decode(s.bytes);
  writeFileSync(jsPgm, writePGM(cropToImage(d).pixels, d.W, d.H));
  execFileSync("python3", [join(ROOT, "decoder-python/ivc_dec.py"), ivc, pyPgm], { stdio: "pipe" });
  assert.deepEqual(readFileSync(jsPgm), readFileSync(pyPgm));
});

test("the Python decoder reports the same two truncation bit positions", () => {
  const py = join(ROOT, "decoder-python/ivc_dec.py");
  const dir = mkdtempSync(join(tmpdir(), "ivc-doc-trunc-"));
  const run = (name) => {
    const out = execFileSync("python3", [py, join(ROOT, "examples/shared-edge", name),
      join(dir, `${name}.pgm`)], { stdio: "pipe" }).toString();
    const m = out.match(/INCOMPLETE at #(\d+): .*consumed (\d+) of (\d+) bits/);
    assert.ok(m, out);
    return { block: Number(m[1]), consumed: Number(m[2]), total: Number(m[3]) };
  };
  const missing = run("missing-last-byte.ivc");
  const misaligned = run("misaligned-marker.ivc");
  assert.equal(missing.block, 1);
  assert.equal(misaligned.block, 1);
  assert.notEqual(missing.consumed, misaligned.consumed);
  assert.equal(missing.consumed, 120);
  assert.equal(misaligned.consumed, 128);
});

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const [name, e] of failures) console.log(`\n--- ${name}\n${e.stack}`);
  process.exit(1);
}
