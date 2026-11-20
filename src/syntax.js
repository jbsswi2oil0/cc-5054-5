// Per-block syntax, normative.  Shared by encoder and decoder.
//
// Order of fields, MSB first:
//   qsel     2 fixed bits, 0..3
//   mode     3 fixed bits, 0..6 (7 reserved, rejected)
//   numAC    unsigned EG0 of (numAC-1), numAC in 1..64
//   DC       signed EG0, zig-zag position 0
//   AC       numAC-1 signed EG0 values, zig-zag positions 1..numAC-1
//
// The 64 coefficient positions are visited in the fixed zig-zag order given by
// ZIGZAG; the encoder must not reorder them.  Positions numAC..63 are implicitly
// zero.  Signed EG0 maps v>0 to 2v-1 and v<=0 to -2v.

import { writeEG0, readEG0, writeEG0Signed, readEG0Signed, mapSigned, unmapSigned } from "./codes.js";
import { ZIGZAG, zigzagToBlock } from "./dct.js";

export const MAX_AC = 64;

// tok = { qsel, mode, numAC, levels: Int32Array(64) in zig-zag order }
export function writeBlock(w, tok) {
  const ranges = {};
  ranges.qsel = w.write(tok.qsel, 2);
  ranges.mode = w.write(tok.mode, 3);
  ranges.numAC = writeEG0(w, tok.numAC - 1);
  ranges.dc = writeEG0Signed(w, tok.levels[0]);
  ranges.ac = [];
  for (let z = 1; z < tok.numAC; z++) ranges.ac.push(writeEG0Signed(w, tok.levels[z]));
  ranges.end = w.pos;
  return ranges;
}

// Returns null if any codeword is incomplete or the syntax is invalid.
export function readBlock(r) {
  try {
    const ranges = {};
    const qsel = r.read(2);
    ranges.qsel = { start: r.pos - 2, end: r.pos };
    const mode = r.read(3);
    ranges.mode = { start: r.pos - 3, end: r.pos };
    if (mode > 6) throw new Error(`reserved mode ${mode}`);
    const numAC = readEG0(r) + 1;
    ranges.numAC = { start: ranges.mode.end, end: r.pos };
    if (numAC > MAX_AC) throw new Error(`numAC ${numAC} out of range`);
    const levels = new Int32Array(64);
    ranges.dc = { start: r.pos, end: r.pos };
    levels[0] = readEG0Signed(r);
    ranges.dc.end = r.pos;
    ranges.ac = [];
    for (let z = 1; z < numAC; z++) {
      const start = r.pos;
      levels[z] = readEG0Signed(r);
      ranges.ac.push({ start, end: r.pos });
    }
    ranges.end = r.pos;
    return { qsel, mode, numAC, levels, ranges };
  } catch (e) {
    return null;
  }
}

// dequantise zig-zag levels into a row-major coefficient block
export function levelsToCoeffs(levels, numAC, stepsZigzag) {
  const q = new Float64Array(64);
  for (let z = 0; z < numAC; z++) q[z] = levels[z] * stepsZigzag[z];
  const coeff = new Float64Array(64);
  zigzagToBlock(q, coeff);
  return coeff;
}

// Lossless block syntax, normative for header.lossless = 1:
//   mode     3 fixed bits
//   rice     4 fixed bits, k in 0..15
//   res[j]   64 Rice-coded signed residuals, raster order j = 0..63
//
// Signed mapping: u = 2v-1 for v>0, u = -2v for v<=0 (same as EG0).
// Rice code of u with parameter k:
//   quotient  q = u >> k, written as q zero bits then a one bit
//   remainder r = u & (2^k - 1), written in k binary digits (MSB first)
// A q of 2^31 or more is not representable and is rejected by the encoder,
// so every codeword has a finite length.
// Reconstruction is exact: clamp(P(r,c) + res[j]).  No transform is used, so
// the lossless path cannot introduce rounding error at all.

export function riceLength(u, k) {
  return (u >> k) + 1 + k;
}

export function writeRice(w, u, k) {
  const start = w.pos;
  const q = u >> k;
  for (let i = 0; i < q; i++) w.bit(0);
  w.bit(1);
  if (k > 0) {
    const mask = (1 << k) - 1;
    w.write(u & mask, k);
  }
  return { start, end: w.pos };
}

export function readRice(r, k) {
  let q = 0;
  while (r.bit() === 0) {
    q++;
    if (q >= (1 << 30)) throw new Error("Rice quotient overflow");
  }
  let v = q << k;
  if (k > 0) v |= r.read(k);
  return v;
}

export function writeLosslessBlock(w, tok) {
  const ranges = {};
  ranges.mode = w.write(tok.mode, 3);
  ranges.rice = w.write(tok.k, 4);
  ranges.res = [];
  for (let j = 0; j < 64; j++) ranges.res.push(writeRice(w, mapSigned(tok.res[j]), tok.k));
  ranges.end = w.pos;
  return ranges;
}

export function readLosslessBlock(r) {
  try {
    const ranges = {};
    const mode = r.read(3);
    ranges.mode = { start: r.pos - 3, end: r.pos };
    if (mode > 6) return null;
    const k = r.read(4);
    ranges.rice = { start: ranges.mode.end, end: r.pos };
    const res = new Int32Array(64);
    ranges.res = [];
    for (let j = 0; j < 64; j++) {
      const start = r.pos;
      res[j] = unmapSigned(readRice(r, k));
      ranges.res.push({ start, end: r.pos });
    }
    ranges.end = r.pos;
    return { mode, k, res, ranges };
  } catch (e) {
    return null;
  }
}

export { ZIGZAG };
