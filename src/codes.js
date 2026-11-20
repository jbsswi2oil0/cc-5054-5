// Exp-Golomb order 0, signed variant.  Normative.
//
//   unsigned k >= 0 -> '1' followed by k in k binary digits   (k=0 -> "1")
//   signed   v      -> unsigned map(v),  v>0 -> 2v-1, v<=0 -> -2v
//
// The code is prefix free and instantaneously decodable, so a truncated tail
// is always detectable (see decodeOrNull).

import { BitstreamTruncated } from "./bits.js";

export function mapSigned(v) { return v > 0 ? 2 * v - 1 : -2 * v; }
export function unmapSigned(k) { return (k & 1) ? (k + 1) >> 1 : (k === 0 ? 0 : -(k >> 1)); }

export function eg0Length(k) { // k >= 0
  const bits = 32 - Math.clz32(k); // binary digits, k=0 -> 0
  return 2 * bits + 1;             // bits zeros, '1', then bits payload
}

// writes one unsigned EG0 value, returns its [start,end) bit range
export function writeEG0(w, k) {
  const start = w.pos;
  const bits = 32 - Math.clz32(k);
  for (let i = 0; i < bits; i++) w.bit(0);
  w.bit(1);
  for (let i = bits - 1; i >= 0; i--) w.bit((k >>> i) & 1);
  return { start, end: w.pos };
}

export function writeEG0Signed(w, v) {
  return writeEG0(w, mapSigned(v));
}

export function readEG0(r) {
  let zeros = 0;
  while (r.bit() === 0) {
    zeros++;
    if (zeros > 31) throw new Error("EG0 length overflow");
  }
  let k = 0;
  for (let i = 0; i < zeros; i++) k = (k << 1) | r.bit();
  return k;
}

export function readEG0Signed(r) { return unmapSigned(readEG0(r)); }
