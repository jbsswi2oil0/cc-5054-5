// Miniature IVC1 writer for documentation and experiments.
//
// Deliberately does NOT call the production encoder or reuse its bit writer,
// syntax writer or codeword writer.  Everything below is a straight
// transcription of the normative comments in src/format.js, src/syntax.js and
// src/codes.js, so a mistake shared by the main encoder and this tool cannot
// hide behind shared code.  Only the structural constants (magic, version,
// order codes) are imported; the side-by-side checker pins those against a
// published legacy stream.
//
// Input is a readable coefficient table, one entry per block:
//
//   { qsel: 0..3, mode: 0..6, dc: <int>, ac: [<int>, ...] }
//
// `ac` holds levels for zig-zag positions 1,2,... .  It may be omitted or
// padded with zeros; the transmitted scan length (numAC) is derived from the
// last non-zero level.  Levels are already quantised integers: this writer
// neither runs the forward transform nor chooses a quantiser.

import { MAGIC, VERSION, ORDER_CODE } from "../../src/format.js";

// ------------------------------------------------------------ bit writer
// MSB-first, independent of src/bits.js.  Records the [start,end) of every
// field it writes.
class DocBits {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; this.pos = 0; }
  write(value, width) {
    if (!Number.isInteger(width) || width < 0 || width > 32) throw new Error(`bad width ${width}`);
    if (width < 32 && (value < 0 || value >= 2 ** width)) {
      // allow 0 in all widths; reject silent truncation of larger values
      if (!(width === 0 && value === 0)) throw new Error(`value ${value} does not fit in ${width} bits`);
    }
    const start = this.pos;
    for (let i = width - 1; i >= 0; i--) {
      this.acc = ((this.acc << 1) | ((Math.floor(value / 2 ** i)) & 1)) & 0xff;
      this.n++; this.pos++;
      if (this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
    return { start, end: this.pos };
  }
  finish() {
    if (this.n > 0) {
      this.bytes.push((this.acc << (8 - this.n)) & 0xff);
      this.acc = 0; this.n = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

// EG0 and signed EG0, transcribed from src/codes.js.
function egBits(k) { let b = 0; for (let v = k; v > 0; v = Math.floor(v / 2)) b++; return b; }
function egLength(k) { return 2 * egBits(k) + 1; }
function writeEG0(w, k) {
  const start = w.pos;
  const bits = egBits(k);
  w.write(0, bits);
  w.write(1, 1);
  if (bits > 0) w.write(k, bits);
  return { start, end: w.pos };
}
function mapSigned(v) { return v > 0 ? 2 * v - 1 : -2 * v; }
function writeEG0Signed(w, v) { return writeEG0(w, mapSigned(v)); }

function writeRice(w, u, k) {
  const start = w.pos;
  const q = Math.floor(u / 2 ** k);
  for (let i = 0; i < q; i++) w.write(0, 1); // quotient: q zeros ...
  w.write(1, 1);                              // ... then a one
  if (k > 0) w.write(u & (2 ** k - 1), k);
  return { start, end: w.pos };
}

// ------------------------------------------------------------- ordering
// The three decode orders from src/format.js; kept local so this module does
// not import src/encode.js.
export function decodeOrder(CW, CH, order) {
  const list = [];
  if (order === "raster") {
    for (let i = 0; i < CW * CH; i++) list.push(i);
  } else if (order === "wavefront") {
    for (let d = 0; d <= CW + CH - 2; d++)
      for (let by = Math.max(0, d - (CW - 1)); by <= Math.min(CH - 1, d); by++)
        list.push(by * CW + (d - by));
  } else if (order === "column") {
    for (let bx = 0; bx < CW; bx++) for (let by = 0; by < CH; by++) list.push(by * CW + bx);
  } else {
    throw new Error(`unknown order ${order}`);
  }
  return list;
}

// -------------------------------------------------------------- table
export function makeTable(header, blocks) {
  const W = header.W, H = header.H;
  const CW = Math.ceil(W / 8), CH = Math.ceil(H / 8);
  if (!Array.isArray(blocks) || blocks.length !== CW * CH) {
    throw new Error(`table has ${blocks && blocks.length} blocks, expected ${CW * CH} (${CW}x${CH})`);
  }
  return {
    W, H, qbase: header.qbase ?? 16, order: header.order ?? "raster",
    lossless: !!header.lossless, blocks,
  };
}

// A block entry for a flat 8x8 tile at the given quantised DC level.
export function flatBlock(dc, { qsel = 2, mode = 0 } = {}) {
  return { qsel, mode, dc, ac: [] };
}

// Reject tables the syntax cannot carry before writing a single bit, and
// normalise them to explicit numAC/levels.
export function validateTable(table) {
  const out = [];
  for (let i = 0; i < table.blocks.length; i++) {
    const b = table.blocks[i] || {};
    const where = `block ${i}`;
    if (!Number.isInteger(b.qsel) || b.qsel < 0 || b.qsel > 3) throw new Error(`${where}: qsel must be 0..3`);
    if (!Number.isInteger(b.mode) || b.mode < 0 || b.mode > 6) throw new Error(`${where}: mode must be 0..6`);
    if (table.lossless) {
      const res = Array.from(b.residual ?? b.res ?? []);
      if (res.length !== 64) throw new Error(`${where}: lossless residual needs 64 entries`);
      for (const v of res) if (!Number.isInteger(v)) throw new Error(`${where}: non-integer residual ${v}`);
      let kk = b.k;
      if (kk === undefined) {
        let best = Infinity;
        for (let k = 0; k <= 15; k++) {
          let bits = 0;
          for (let j = 0; j < 64; j++) bits += Math.floor(mapSigned(res[j]) / 2 ** k) + 1 + k;
          if (bits < best) { best = bits; kk = k; }
        }
      }
      out.push({ qsel: 0, mode: b.mode, k: kk, levels: Int32Array.from(res), numAC: 64, residual: res });
      continue;
    }
    if (!Number.isInteger(b.dc)) throw new Error(`${where}: dc must be an integer`);
    const ac = Array.from(b.ac ?? []);
    if (ac.length > 63) throw new Error(`${where}: ${ac.length} AC levels, max 63`);
    for (const v of ac) if (!Number.isInteger(v)) throw new Error(`${where}: non-integer AC level ${v}`);
    let numAC = ac.length + 1;
    while (numAC > 1 && ac[numAC - 2] === 0) numAC--;
    const levels = new Int32Array(64);
    levels[0] = b.dc;
    for (let z = 1; z < numAC; z++) levels[z] = ac[z - 1];
    out.push({ qsel: b.qsel, mode: b.mode, dc: b.dc, ac: ac.slice(0, Math.max(0, numAC - 1)),
               numAC, levels });
  }
  return { ...table, blocks: out };
}

// --------------------------------------------------------------- write
// Returns { bytes, totalBits, headerBits, paddingBits, blocks } where
// blocks[i] is the exact bit record in decode order.
export function writeStream(table, { headerBitsOverride } = {}) {
  if (headerBitsOverride !== undefined) throw new Error("header length is fixed by the format");
  const t = validateTable(table);
  const { W, H, qbase, order, lossless } = t;
  const CW = Math.ceil(W / 8), CH = Math.ceil(H / 8);
  const w = new DocBits();

  w.write(MAGIC, 32);
  w.write(VERSION, 4);
  w.write(W - 1, 12);
  w.write(H - 1, 12);
  w.write(qbase - 1, 8);
  w.write(lossless ? 1 : 0, 1);
  w.write(ORDER_CODE[order], 2);
  w.write(0, 1); // encoder strategy hint, ignored by decoders
  w.write(0, 7); // reserved
  const headerBits = w.pos;

  const orderList = decodeOrder(CW, CH, order);
  const blocks = new Array(CW * CH);

  for (const i of orderList) {
    const b = t.blocks[i];
    const bitStart = w.pos;
    const ranges = {};
    if (lossless) {
      ranges.mode = w.write(b.mode, 3);
      ranges.rice = w.write(b.k, 4);
      ranges.res = [];
      for (let j = 0; j < 64; j++) ranges.res.push(writeRice(w, mapSigned(b.residual[j]), b.k));
      ranges.end = w.pos;
      blocks[i] = { index: i, bx: i % CW, by: (i / CW) | 0, mode: b.mode, k: b.k, qsel: 0,
                    levels: b.levels, numAC: 64, bitStart, bitEnd: w.pos, ranges, lossless: true };
      continue;
    }
    ranges.qsel = w.write(b.qsel, 2);
    ranges.mode = w.write(b.mode, 3);
    ranges.numAC = writeEG0(w, b.numAC - 1);
    ranges.dc = writeEG0Signed(w, b.dc);
    ranges.ac = [];
    for (let z = 1; z < b.numAC; z++) ranges.ac.push(writeEG0Signed(w, b.levels[z]));
    ranges.end = w.pos;
    blocks[i] = { index: i, bx: i % CW, by: (i / CW) | 0, qsel: b.qsel, mode: b.mode,
                  numAC: b.numAC, levels: b.levels, bitStart, bitEnd: w.pos, ranges,
                  lossless: false };
  }

  const bytes = w.finish();
  const totalBits = w.pos;
  return {
    table: t, bytes, totalBits, headerBits,
    byteLength: bytes.length,
    paddingBits: (8 - (totalBits % 8)) % 8,
    orderList, blocks, W, H, CW, CH, qbase, order, lossless,
  };
}

// Number of bits a single block entry will occupy, without writing it.
export function blockBitLength(b) {
  if (b.lossless) {
    let n = 3 + 4;
    for (let j = 0; j < 64; j++) n += Math.floor(mapSigned(b.residual[j]) / 2 ** b.k) + 1 + b.k;
    return n;
  }
  let n = 2 + 3 + egLength(b.numAC - 1) + egLength(mapSigned(b.dc));
  for (let z = 1; z < b.numAC; z++) n += egLength(mapSigned(b.levels[z]));
  return n;
}

