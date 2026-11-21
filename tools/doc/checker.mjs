// Bit-position checker and reverse pixel lookup.
//
// Reads three kinds of stream through one code path:
//   valid            every block verified and published
//   unknown version  header rejected at the 4-bit version field; the exact
//                    bit range of the rejected field is reported
//   truncated        the last block is locatable but not publishable; the
//                    failure bit position is reported
//
// `lookupPixel` walks from a pixel in the experiment window back to the
// coefficient whose removal changes it most and to the exact bit range that
// carried that coefficient.  The experiment window is given in pixels, not
// blocks, so an off-by-one in the block grid shows up as an out-of-window
// answer rather than being hidden by block rounding.

import { buildDirectory, seekDirectory } from "./directory.mjs";
import { stepGrid, reconstruct } from "./parser.mjs";
import { QM, QSEL_MULT } from "../../src/quant.js";
import { idct8x8, ZIGZAG } from "../../src/dct.js";

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function bitsAt(bytes, start, end) {
  const limit = Math.min(end, bytes.length * 8);
  let s = "";
  for (let p = start; p < limit; p++) {
    if (p > start && (p - start) % 8 === 0) s += " ";
    s += (bytes[p >> 3] >> (7 - (p & 7))) & 1;
  }
  return s;
}

// Parse the whole stream with this parser and keep the reconstruction.
export function analyse(bytes, { bitLen = bytes.length * 8, quant } = {}) {
  const dir = buildDirectory(bytes, { bitLen, quant });
  const h = dir.header;
  if (!h) return { dir, error: dir.error, pixels: null, header: null };
  const rec = reconstruct(h, dir.entries, bytes, quant || { QM, QSEL_MULT });
  return { dir, header: h, rec, pixels: rec.canvas, bytes };
}

// Structural report for a stream.  `status` is one of
//   "valid" | "truncated" | "unknown-version" | "bad-header" | "unpublished-blocks".
export function checkStream(bytes, { bitLen = bytes.length * 8 } = {}) {
  const info = analyse(bytes, { bitLen });
  const h = info.header;
  if (!h) {
    const err = info.error;
    const kind = err.kind === "version" ? "unknown-version"
      : err.kind === "truncated-header" ? "truncated-header" : "bad-header";
    return {
      status: kind,
      error: err,
      bitRange: { start: err.bitStart, end: err.bitEnd },
      bits: bitsAt(bytes, err.bitStart, err.bitEnd),
    };
  }
  const dir = info.dir;
  const published = dir.published;
  const blockCount = h.CW * h.CH;
  let status;
  if (dir.truncated) status = "truncated";
  else if (published.length === blockCount) status = "valid";
  else status = "unpublished-blocks";

  return {
    status,
    header: h,
    bitLength: dir.bitLength,
    totalBits: dir.totalBits,
    published,
    publishedCount: published.length,
    blockCount,
    failure: dir.failure
      ? { ...dir.failure, bits: dir.failure.kind === "truncated" || dir.failure.kind === "syntax"
          ? bitsAt(bytes, dir.failure.startBit, dir.failure.bitPos ?? dir.failure.endBit) : "" }
      : null,
    directory: seekDirectory(dir),
    dir,
    pixels: info.pixels,
  };
}

// Reverse lookup from a pixel to coefficients and their exact bits.
export function lookupPixel(bytes, px, py, { bitLen, reference } = {}) {
  const info = analyse(bytes, { bitLen });
  const h = info.header;
  if (!h) return { error: info.error || "unreadable header" };
  if (!(Number.isInteger(px) && Number.isInteger(py) && px >= 0 && py >= 0 && px < h.W && py < h.H)) {
    return { error: `pixel (${px},${py}) outside the ${h.W}x${h.H} image` };
  }
  const block = (py >> 3) * h.CW + (px >> 3);
  const e = info.dir.entries[block];
  if (!e) return { error: `no directory entry for block ${block}` };
  if (!e.token) return { error: `block ${block} is not decodable: ${e.error}`, entry: e };

  const value = info.pixels[py * h.PW + px];
  const predForBlock = info.rec.out[block].pred;
  const r = py & 7, c = px & 7;

  if (e.token.lossless) {
    return {
      pixel: { x: px, y: py, block, value },
      blockEntry: { startBit: e.startBit, endBit: e.endBit, published: e.published },
      bitRange: { start: e.startBit, end: e.endBit, bits: bitsAt(bytes, e.startBit, e.endBit) },
      coefficients: [],
      contributor: { kind: "rice", j: r * 8 + c, bits: e.ranges.res[r * 8 + c],
                     residual: e.token.res[r * 8 + c] },
    };
  }

  const steps = stepGrid(h.qbase, e.token.qsel, QM, QSEL_MULT);
  const coeffs = [];
  for (let z = 0; z < e.token.numAC; z++) {
    const [u, v] = ZIGZAG[z];
    coeffs.push({
      z, u, v, level: e.token.levels[z], step: steps[z],
      dequant: e.token.levels[z] * steps[z],
      bits: z === 0 ? e.ranges.dc : e.ranges.ac[z - 1],
    });
  }

  // Which transmitted coefficient most affects this pixel?  Reconstruct the
  // block with each coefficient zeroed and compare the clicked sample.  The
  // pixel is a fixed linear combination of the coefficients, so this is exact
  // for the inverse transform.
  let contributor = null;
  for (const cf of coeffs) {
    const zz = new Float64Array(64);
    for (let z = 0; z < e.token.numAC; z++) if (z !== cf.z) zz[z] = e.token.levels[z] * steps[z];
    const coeff = new Float64Array(64);
    for (let z = 0; z < 64; z++) { const [u, v] = ZIGZAG[z]; coeff[u * 8 + v] = zz[z]; }
    const inv = idct8x8(coeff);
    const alt = clamp255(Math.round(inv[r * 8 + c] + predForBlock[r * 8 + c]));
    const delta = Math.abs(alt - value);
    if (!contributor || delta > contributor.delta) contributor = { ...cf, delta, alt };
  }

  const first = e.ranges.dc;
  const last = e.ranges.ac.length ? e.ranges.ac[e.ranges.ac.length - 1] : e.ranges.dc;
  return {
    pixel: { x: px, y: py, block, value },
    blockEntry: { startBit: e.startBit, endBit: e.endBit, published: e.published },
    bitRange: { start: first.start, end: last.end, bits: bitsAt(bytes, first.start, last.end) },
    coefficients: coeffs,
    contributor,
  };
}

// Explain a wrong pixel in a damaged stream relative to the intact stream it
// came from.  Reports:
//   where      the block owning the pixel and whether that block is published
//   actualBits the exact bit range of the block in the damaged stream
//   source     the block AND coefficient whose bit range, in the intact
//              stream, was overwritten or removed by the fault
// The pixel is traced by re-parsing the damaged stream, so a corrupt block
// can be traced even when it is not decodable.
export function explainPixel(damagedBytes, damagedBitLen, intactBytes, px, py) {
  const intact = analyse(intactBytes, { bitLen: intactBytes.length * 8 });
  const h = intact.header;
  if (!h) return { error: "intact stream unreadable" };
  if (px < 0 || py < 0 || px >= h.W || py >= h.H) return { error: `pixel (${px},${py}) outside image` };
  const block = (py >> 3) * h.CW + (px >> 3);
  const ref = intact.dir.entries[block];

  // Reconstruct the intact pixel and the damaged pixel.
  const damaged = analyse(damagedBytes, { bitLen: damagedBitLen });
  const refValue = intact.pixels[py * h.PW + px];
  let damagedValue = null;
  if (damaged.header) {
    damagedValue = damaged.pixels[py * h.PW + px];
  } else {
    // header gone: the pixel cannot be reconstructed at all
    damagedValue = null;
  }

  // Find the first bit at which the two streams differ; that is the fault site.
  const total = Math.min(intactBytes.length, damagedBytes.length) * 8;
  let firstDiff = -1;
  for (let p = 0; p < total; p++) {
    const a = (intactBytes[p >> 3] >> (7 - (p & 7))) & 1;
    const b = (damagedBytes[p >> 3] >> (7 - (p & 7))) & 1;
    if (a !== b) { firstDiff = p; break; }
  }

  // Attribute the fault site to a field of the intact stream.
  let source = null;
  if (firstDiff >= 0) {
    if (firstDiff < h.headerBits) {
      source = { kind: "header", field: firstDiff < 32 ? "magic" : firstDiff < 36 ? "version" : "header", bit: firstDiff };
    } else {
      for (const i of intact.dir.orderList) {
        const e = intact.dir.entries[i];
        if (!e) continue;
        if (firstDiff >= e.startBit && firstDiff < e.endBit) {
          let field = "block";
          if (ref.ranges) {
            if (firstDiff < e.ranges.mode.end) field = "qsel/mode";
            else if (firstDiff < e.ranges.numAC.end) field = "numAC";
            else if (firstDiff < e.ranges.dc.end) field = "DC";
            else field = "AC";
          }
          source = { kind: "block", block: i, bit: firstDiff, field,
                     blockRange: { start: e.startBit, end: e.endBit } };
          break;
        }
      }
    }
  }

  // Locate the coefficient closest to the fault site in the block that owns
  // the disturbed bits (which need not be the clicked pixel's block).
  let coefficient = null;
  if (source && source.kind === "block") {
    const src = intact.dir.entries[source.block];
    if (src && src.token && !src.token.lossless) {
      const ranges = src.ranges;
      for (let z = 0; z < src.token.numAC; z++) {
        const rg = z === 0 ? ranges.dc : ranges.ac[z - 1];
        if (firstDiff >= rg.start && firstDiff < rg.end) {
          const [u, v] = ZIGZAG[z];
          coefficient = { block: source.block, z, u, v, level: src.token.levels[z], bitRange: rg };
          break;
        }
      }
    }
  }

  return {
    pixel: { x: px, y: py, block },
    refValue, damagedValue,
    correct: refValue === damagedValue,
    firstDifferenceBit: firstDiff,
    source,
    coefficient,
    damagedBlockPublished: damaged.dir ? !!(damaged.dir.entries[block] && damaged.dir.entries[block].published) : false,
    damagedStatus: damaged.header ? (damaged.dir.truncated ? "truncated" : "parsed") : "unreadable",
  };
}

