#!/usr/bin/env node
// Rebuild documentation samples after a quantiser-table change, and show
// whether an old decoder still produces the original pixels.
//
//   node tools/doc/quantiser.mjs                    from the current src/quant.js
//   node tools/doc/quantiser.mjs --table table.json  from an explicit table
//   node tools/doc/quantiser.mjs --diff old.json     compare against a saved table
//
// A table JSON is:
//   { "QM": [[16,...],...], "QSEL_MULT": [10,13,16,22] }
//
// Rebuilding re-quantises each documented sample's integer coefficients with
// the new steps, rewrites the affected example streams with the miniature
// writer, and decodes both the old and the new streams with the *old* decoder
// via the independent parser using the old table.  The report states whether
// the old decoder still lands on the original pixels.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QM, QSEL_MULT } from "../../src/quant.js";
import { makeTable, writeStream } from "./miniwriter.mjs";
import { buildDirectory } from "./directory.mjs";
import { reconstruct, stepGrid } from "./parser.mjs";
import { decode, cropToImage } from "../../src/decode.js";
import { sharedEdgeTable, legacyTable } from "./fixtures.mjs";
import { fdct8x8, blockToZigzag, ZIGZAG } from "../../src/dct.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(n);

function loadTable(path) {
  const t = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(t.QM) || t.QM.length !== 8) throw new Error("table QM must be 8 rows");
  if (!Array.isArray(t.QSEL_MULT) || t.QSEL_MULT.length !== 4) throw new Error("QSEL_MULT must have 4 entries");
  return { QM: t.QM, QSEL_MULT: t.QSEL_MULT };
}

const newTablePath = arg("--table", null);
const diffPath = arg("--diff", null);
const regen = flag("--write");
const newQuant = newTablePath ? loadTable(newTablePath) : { QM, QSEL_MULT };
const oldQuant = diffPath ? loadTable(diffPath) : { QM, QSEL_MULT };

// Re-quantise a readable table (levels) against a quantiser: produce a new
// level table from the reconstructed coefficient domain.  The documentation
// samples are stored as levels, so "the maintainer changes the table" means
// the step changes for the same coefficient; we recover the coefficients and
// re-quantise them.
function requantise(table, fromQuant, toQuant) {
  const blocks = [];
  for (const b of table.blocks) {
    const fromSteps = stepGrid(table.qbase ?? 16, b.qsel, fromQuant.QM, fromQuant.QSEL_MULT);
    const toSteps = stepGrid(table.qbase ?? 16, b.qsel, toQuant.QM, toQuant.QSEL_MULT);
    const ac = [];
    for (let z = 0; z < (b.ac ? b.ac.length : 0); z++) {
      const coeff = b.ac[z] * fromSteps[z + 1];
      ac.push(Math.round(coeff / toSteps[z + 1]));
    }
    const dcCoeff = b.dc * fromSteps[0];
    blocks.push({ qsel: b.qsel, mode: b.mode, dc: Math.round(dcCoeff / toSteps[0]), ac });
  }
  return { ...table, blocks };
}

function pixelsOf(stream, quant) {
  const dir = buildDirectory(stream.bytes);
  const rec = reconstruct(dir.header, dir.entries, stream.bytes, quant);
  return rec.canvas;
}

function cropOf(stream) {
  const d = decode(stream.bytes);
  return cropToImage(d).pixels;
}

const samples = {
  "shared-edge": sharedEdgeTable(),
  legacy: legacyTable(),
};

const report = { builtWith: newTablePath || "src/quant.js", comparedWith: diffPath || null, samples: {} };
let lines = [];

for (const [name, table] of Object.entries(samples)) {
  const oldStream = writeStream(table); // levels built for the old table
  const newTable = requantise(table, oldQuant, newQuant);
  const newStream = writeStream(newTable);

  const oldPix = pixelsOf(oldStream, oldQuant);
  const newPix = pixelsOf(newStream, newQuant);
  // The old decoder applied to the new stream: it uses the OLD steps.
  const oldDecodesNew = pixelsOf(newStream, oldQuant);
  const sameUnderOld = oldPix.length === oldDecodesNew.length && oldPix.every((v, i) => v === oldDecodesNew[i]);
  const sameUnderNew = oldPix.length === newPix.length && oldPix.every((v, i) => v === newPix[i]);

  let byteDiff = oldStream.byteLength !== newStream.byteLength;
  let bitDiff = oldStream.totalBits !== newStream.totalBits;

  report.samples[name] = {
    oldTotalBits: oldStream.totalBits,
    newTotalBits: newStream.totalBits,
    oldByteLength: oldStream.byteLength,
    newByteLength: newStream.byteLength,
    lengthChanged: bitDiff || byteDiff,
    oldDecoderOnNewStream: {
      samePixelsAsOriginal: sameUnderOld,
      note: sameUnderOld
        ? "the old decoder reproduces the original pixels from the rebuilt stream"
        : "the old decoder produces DIFFERENT pixels from the rebuilt stream",
    },
    newDecoderOnNewStream: {
      samePixelsAsOriginal: sameUnderNew,
      note: sameUnderNew
        ? "the new decoder reproduces the original pixels (quantiser change is pixel-neutral here)"
        : "the new decoder produces DIFFERENT pixels (expected when steps change)",
    },
  };

  lines.push(`${name}:`);
  lines.push(`  bits ${oldStream.totalBits} -> ${newStream.totalBits}, bytes ${oldStream.byteLength} -> ${newStream.byteLength}`);
  lines.push(`  old decoder on rebuilt stream: ${sameUnderOld ? "same pixels" : "DIFFERENT pixels"}`);
  lines.push(`  new decoder on rebuilt stream: ${sameUnderNew ? "same pixels" : "different pixels"}`);

  if (regen) {
    // Rewrite the affected example sample in place, under examples/<name>/.
    const dir = join(ROOT, "examples", name);
    if (!existsSync(dir)) continue;
    writeFileSync(join(dir, "stream.ivc"), newStream.bytes);
    lines.push(`  wrote examples/${name}/stream.ivc`);
  }
}

console.log(JSON.stringify(report, null, 2));
console.error(lines.join("\n"));
