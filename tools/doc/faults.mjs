// Fault injection for the experiment fixtures.
//
// The fault operations are expressed in bits, not bytes, so a report can name
// the exact bit that changed and the exact bits that were removed.  A damaged
// stream is always accompanied by the intact stream it came from, so a test
// can prove that undamaged prefix blocks still decode to the right pixels.

// Remove the last `n` bits of the stream, leaving the file's byte length at
// ceil((totalBits-n)/8).  This models a transfer that lost bits, not bytes.
export function dropTailBits(bytes, totalBits, n) {
  if (n <= 0 || n >= totalBits) throw new Error(`drop ${n} of ${totalBits} bits`);
  const bits = [];
  for (let i = 0; i < totalBits - n; i++) bits.push((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  return { bytes: packBits(bits), bitLength: bits.length };
}

// Delete exactly one bit at `position`, shifting every later bit left by one.
// The resulting file is one bit shorter in content; its byte length may or may
// not change because of padding.
export function deleteBit(bytes, totalBits, position) {
  if (!(position >= 0 && position < totalBits)) throw new Error(`bit ${position} outside 0..${totalBits}`);
  const bits = [];
  for (let i = 0; i < totalBits; i++) if (i !== position) bits.push((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  return { bytes: packBits(bits), bitLength: bits.length, deletedAt: position };
}

// Invert exactly one bit.  Length in bits is preserved, so a block's own bit
// range does not move.
export function flipBit(bytes, totalBits, position) {
  if (!(position >= 0 && position < totalBits)) throw new Error(`bit ${position} outside 0..${totalBits}`);
  const out = Uint8Array.from(bytes);
  out[position >> 3] ^= 1 << (7 - (position & 7));
  return { bytes: out, bitLength: totalBits, flippedAt: position };
}

export function bitsOf(bytes, startBit, endBit) {
  const list = [];
  for (let p = startBit; p < endBit; p++) list.push((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  return list;
}

export function packBits(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  return out;
}
