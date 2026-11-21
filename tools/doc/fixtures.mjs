// Documentation fixtures for the intra-frame experiment.
//
// This module is the single source of truth for every example under
// examples/.  It never calls src/encode.js: the streams are assembled from
// readable coefficient tables by tools/doc/miniwriter.mjs, then checked with
// the independent parser in tools/doc/parser.mjs.  Regenerating the examples
// is `node tools/doc/examples.mjs`.
//
// Each fixture yields:
//   { name, description, table, stream, bytes, bitLength, facts, notes }
// `facts` are values that a test asserts, computed here rather than typed by
// hand, so a maintainer who changes a quantiser sees the fixture's expected
// outcome change too.

import { makeTable, writeStream } from "./miniwriter.mjs";
import { buildDirectory } from "./directory.mjs";
import { checkStream, explainPixel } from "./checker.mjs";
import { dropTailBits, deleteBit, flipBit, packBits, bitsOf } from "./faults.mjs";
import { decode, cropToImage } from "../../src/decode.js";

const W = 16, H = 8;

// The shared-edge example.  Block 0 sits on the left and block 1 to its right.
// Block 0's last transmitted coefficient is a NEGATIVE AC level and the block
// ends exactly on a byte boundary (bit 112), so its right column is a prediction
// edge for block 1.  Block 1 uses horizontal prediction (mode H) with a small
// DC, so it inherits block 0's right column verbatim.
export function sharedEdgeTable() {
  return makeTable({ W, H, qbase: 16, order: "raster" }, [
    { qsel: 0, mode: 0, dc: -3, ac: [-4, -3] }, // last AC is -3, block ends at 112
    { qsel: 0, mode: 2, dc: 2, ac: [] },         // mode H: copies block 0's right column
  ]);
}

// A two-block table whose block 1 is intentionally expensive to code from
// scratch, used to show an old decoder still landing on the same pixels after
// a quantiser change.  See `quantiserRebuild`.
export function legacyTable() {
  return makeTable({ W, H, qbase: 16, order: "raster" }, [
    { qsel: 2, mode: 0, dc: 60, ac: [8, -6, 4, 0, -3, 2] },
    { qsel: 2, mode: 3, dc: -40, ac: [0, 5, -2, 1, 0, -1, 2] },
  ]);
}

// The documentation's "smallest possible" example: one 8x8 block, one non-zero
// level.  Every field is one fixed codeword or one EG0 codeword.
export function minimalTable() {
  return makeTable({ W: 8, H: 8, qbase: 16, order: "raster" }, [
    { qsel: 0, mode: 0, dc: 16, ac: [] },
  ]);
}

// Decode a stream through the production decoder and return its image crop.
export function productionPixels(bytes) {
  const d = decode(bytes);
  return { decoded: d, crop: cropToImage(d) };
}

// ------------------------------------------------------------------ build
// Assemble the canonical stream and its three documented damage cases:
//   missing-last-byte    the true last byte was lost (reported mid-block)
//   misaligned-marker    byte count is correct but one bit was deleted from
//                        block 1 so its end marker sits one bit early
//   shared-edge-flip     one bit of block 0's last AC level is inverted; block
//                        1's own bits are untouched but its prediction changes
export function buildSharedEdge() {
  const table = sharedEdgeTable();
  const stream = writeStream(table);
  const dir = buildDirectory(stream.bytes);
  const intact = productionPixels(stream.bytes);

  const e0 = dir.entries[0], e1 = dir.entries[1];
  const lastAC = e0.ranges.ac[e0.ranges.ac.length - 1];

  // (E1) genuinely missing the final byte.  Check it as stored (its natural
  // byte length), which is what the checker sees for a 15-byte file.
  const missing = dropTailBits(stream.bytes, stream.totalBits, 8);
  const missingCheck = checkStream(missing.bytes);

  // (E2) same byte count as the intact stream, but bit 113 deleted and the
  // tail zero-filled so the stored length is unchanged.  The end marker now
  // sits earlier than the byte count implies.
  const bits = bitsOf(stream.bytes, 0, stream.totalBits);
  bits.splice(113, 1);
  while (bits.length < stream.byteLength * 8) bits.push(0);
  const misaligned = { bytes: packBits(bits), bitLength: bits.length };
  const misalignedCheck = checkStream(misaligned.bytes, { bitLen: misaligned.bitLength });

  // (P) flip a bit inside block 0's last AC codeword (bit 109).  Length is
  // preserved; block 1's own bit range and codewords are unchanged, but its
  // prediction is wrong because the shared edge moved.
  const flipped = flipBit(stream.bytes, stream.totalBits, 109);
  const flippedCheck = checkStream(flipped.bytes, { bitLen: flipped.bitLength });
  const flippedDir = buildDirectory(flipped.bytes);
  const flippedPixels = productionPixels(flipped.bytes);

  // A pixel in block 1 that is wrong only because of the prediction change.
  let ei;
  for (let r = 0; r < 8 && ei === undefined; r++) {
    const y = r, x = 8;
    const idx = y * W + x;
    if (intact.crop.pixels[idx] !== flippedPixels.crop.pixels[idx]) ei = { x, y, index: idx };
  }
  const explain = explainPixel(flipped.bytes, flipped.bitLength, stream.bytes, ei.x, ei.y);

  const nonZero = [];
  for (let z = 0; z < e0.token.numAC; z++) nonZero.push(e0.token.levels[z]);

  return {
    name: "shared-edge",
    table,
    stream,
    bytes: stream.bytes,
    byteLength: stream.byteLength,
    bitLength: stream.totalBits,
    intact,
    facts: {
      W, H,
      headerBits: stream.headerBits,
      totalBits: stream.totalBits,
      byteLength: stream.byteLength,
      block0: { startBit: stream.blocks[0].bitStart, endBit: stream.blocks[0].bitEnd,
                byteAligned: stream.blocks[0].bitEnd % 8 === 0 },
      block1: { startBit: stream.blocks[1].bitStart, endBit: stream.blocks[1].bitEnd,
                mode: e1.token.mode },
      block0Levels: nonZero,
      lastACCoefficient: { z: e0.token.numAC - 1, level: e0.token.levels[e0.token.numAC - 1],
                           bitRange: { start: lastAC.start, end: lastAC.end } },
      // both truncation manifestations
      missingLastByte: {
        status: missingCheck.status,
        byteCount: missing.bytes.length,
        failureIndex: missingCheck.failure.index,
        failureBit: missingCheck.failure.bitPos,
        reportedInsideByte: Math.floor(missingCheck.failure.bitPos / 8),
        intactEndByte: Math.floor(stream.totalBits / 8),
        checkedBitLength: missing.bytes.length * 8,
      },
      misalignedMarker: {
        status: misalignedCheck.status,
        byteCount: misaligned.bytes.length,
        failureIndex: misalignedCheck.failure.index,
        failureBit: misalignedCheck.failure.bitPos,
        reportedInsideByte: Math.floor(misalignedCheck.failure.bitPos / 8),
      },
      // shared-edge propagation
      sharedEdge: {
        flippedBit: 109,
        block0RangeChanged: flippedDir.entries[0].bitStart !== e0.startBit || flippedDir.entries[0].bitEnd !== e0.endBit,
        block1TokenUnchanged: JSON.stringify(flippedDir.entries[1].token.levels) === JSON.stringify(e1.token.levels),
        block1RangeUnchanged: flippedDir.entries[1].startBit === e1.startBit && flippedDir.entries[1].endBit === e1.endBit,
        wrongPixel: ei ? { x: ei.x, y: ei.y, intact: intact.crop.pixels[ei.index], flipped: flippedPixels.crop.pixels[ei.index] } : null,
        decodeStillOk: flippedCheck.status === "valid",
        firstDifferenceBit: explain.firstDifferenceBit,
        sourceBlock: explain.source && explain.source.block,
      },
    },
    damaged: { missing, misaligned, flipped },
    checks: { intact: checkStream(stream.bytes), flipped: flippedCheck },
  };
}

// ------------------------------------------------------------------ legacy
// A published older-format example.  The stream is built once and frozen under
// examples/legacy/; the side-by-side checker compares a freshly parsed stream
// against it bit for bit, so an encoder regression cannot silently agree with a
// docs-tool bug.
export function buildLegacy() {
  const table = legacyTable();
  const stream = writeStream(table);
  return { name: "legacy", table, stream, bytes: stream.bytes, bitLength: stream.totalBits };
}

// ------------------------------------------------------------------ minimal
export function buildMinimal() {
  const table = minimalTable();
  const stream = writeStream(table);
  const dir = buildDirectory(stream.bytes);
  const e = dir.entries[0];
  return {
    name: "minimal",
    table, stream, bytes: stream.bytes, bitLength: stream.totalBits,
    facts: {
      totalBits: stream.totalBits, byteLength: stream.byteLength,
      headerBits: stream.headerBits,
      fields: e.ranges, levels: Array.from(e.token.levels.slice(0, e.token.numAC)),
      published: dir.published,
    },
  };
}
