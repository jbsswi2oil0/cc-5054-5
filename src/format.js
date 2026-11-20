// Container format, normative.
//
// Header, 79 bits, MSB first:
//   magic      32  'IVC1' = 0x49564331
//   version     4  1
//   width-1    12  image width  in pixels, image width  = value+1 (1..4096)
//   height-1   12  image height in pixels, image height = value+1 (1..4096)
//   qbase-1     8  base quantiser, qbase = value+1 (1..256)
//   lossless    1  0 = DCT path, 1 = residual path (ignores qbase)
//   order       2  block decode order, see below
//   strategy    1  encoder hint only, ignored by the decoder
//   reserved    7  must be 0
//
// Decode orders (all linear extensions of the "left and top first" partial
// order, so a block always finds both of its reference edges ready):
//   0 raster      row by row, left to right
//   1 wavefront   anti-diagonals, bx+by increasing
//   2 column      column by column, top to bottom
// For every order the same rule applies: a block may read its left column
// when block (bx-1,by) has been decoded, and its top row when (bx,by-1) has
// been decoded.  Encoder and decoder evaluate the same predicate.
//
// Then CW*CH blocks in the order named in the header, CW = ceil(W/8),
// CH = ceil(H/8).
// Block syntax is defined in syntax.js.  There is no terminator: the decoder
// stops after CW*CH blocks, so any trailing byte padding is never consumed and
// a byte-truncated stream is detected exactly at the block that could not be
// completed.

import { BitWriter, BitReader } from "./bits.js";

export const MAGIC = 0x49564331;
export const VERSION = 1;
export const HEADER_BITS = 79;

export const ORDERS = ["raster", "wavefront", "column"];
export const ORDER_CODE = { raster: 0, wavefront: 1, column: 2 };

export function buildHeader({ W, H, qbase = 16, lossless = false,
                              strategy = "local", order = "raster" }) {
  if (!(W >= 1 && W <= 4096 && H >= 1 && H <= 4096)) throw new Error("image size out of range");
  if (!(qbase >= 1 && qbase <= 256)) throw new Error("qbase out of range");
  if (!(order in ORDER_CODE)) throw new Error(`unknown order ${order}`);
  return {
    magic: MAGIC, version: VERSION, W, H, qbase,
    lossless: !!lossless, order,
    strategyBit: strategy === "chain" ? 1 : 0,
  };
}

export function writeHeader(w, h) {
  w.write(h.magic, 32);
  w.write(h.version, 4);
  w.write(h.W - 1, 12);
  w.write(h.H - 1, 12);
  w.write(h.qbase - 1, 8);
  w.write(h.lossless ? 1 : 0, 1);
  w.write(ORDER_CODE[h.order], 2);
  w.write(h.strategyBit ?? 0, 1);
  w.write(0, 7);
  return w.pos;
}

// Returns header or throws a descriptive Error.
export function readHeader(bytes) {
  const r = new BitReader(bytes);
  const magic = r.read(32);
  if (magic !== MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  const version = r.read(4);
  if (version !== VERSION) throw new Error(`unsupported version ${version}`);
  const W = r.read(12) + 1;
  const H = r.read(12) + 1;
  const qbase = r.read(8) + 1;
  const lossless = r.read(1) === 1;
  const orderCode = r.read(2);
  const strategyBit = r.read(1);
  const reserved = r.read(7);
  if (reserved !== 0) throw new Error("reserved header bits are not zero");
  if (orderCode > 2) throw new Error(`unsupported decode order ${orderCode}`);
  return {
    magic, version, W, H, qbase, lossless,
    order: ORDERS[orderCode],
    strategy: strategyBit ? "chain" : "local",
    CW: Math.ceil(W / 8), CH: Math.ceil(H / 8),
    headerBits: HEADER_BITS,
  };
}

// Render a bit range as a compact string grouped in 8s, e.g. "10110011 01".
export function bitsToString(bytes, start, end) {
  let s = "";
  for (let p = start; p < end; p++) {
    if (p > start && (p - start) % 8 === 0) s += " ";
    s += (bytes[p >> 3] >> (7 - (p & 7))) & 1;
  }
  return s;
}

export function rangeToBytes(bytes, startBit, endBit) {
  const a = startBit >> 3, b = (endBit + 7) >> 3;
  return bytes.slice(a, b);
}

export function hexDump(bytes, startBit = 0, endBit = bytes.length * 8) {
  const a = startBit >> 3, b = Math.min(bytes.length, (endBit + 7) >> 3);
  const lines = [];
  for (let off = a; off < b; off += 16) {
    const chunk = Array.from(bytes.slice(off, Math.min(off + 16, b)));
    const hex = chunk.map((v) => v.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${off.toString(16).padStart(6, "0")}  ${hex}`);
  }
  return lines.join("\n");
}
