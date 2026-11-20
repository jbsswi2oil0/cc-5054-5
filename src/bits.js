// MSB-first bit writer.  Every write returns the [bitStart,bitEnd) range it
// occupied in the final stream, which is what powers the "click a block, see
// its bits" trace.
export class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
    this.pos = 0; // total bits written
  }
  bit(b) {
    const start = this.pos;
    this.cur = (this.cur << 1) | (b & 1);
    this.nbits++;
    this.pos++;
    if (this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
    return { start, end: this.pos };
  }
  write(value, nbits) {
    const start = this.pos;
    for (let i = nbits - 1; i >= 0; i--) this.bit((value >>> i) & 1);
    return { start, end: this.pos };
  }
  // convenience: write and return range in one call
  u(nbits, value) { return this.write(value, nbits); }
  // Flushes the partial byte with zero padding.  `pos` keeps counting only
  // the bits that were written, so callers can report the exact bit length.
  finish() {
    if (this.nbits > 0) {
      this.bytes.push((this.cur << (8 - this.nbits)) & 0xff);
      this.cur = 0; this.nbits = 0;
    }
    return new Uint8Array(this.bytes);
  }
}

export class BitReader {
  constructor(bytes, bitLen = bytes.length * 8) {
    this.bytes = bytes;
    this.bitLen = bitLen;
    this.pos = 0;
  }
  get eof() { return this.pos >= this.bitLen; }
  bit() {
    if (this.pos >= this.bitLen) throw new BitstreamTruncated(this.pos);
    const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  read(nbits) {
    let v = 0;
    for (let i = 0; i < nbits; i++) v = (v << 1) | this.bit();
    return v;
  }
}

export class BitstreamTruncated extends Error {
  constructor(pos) { super(`bitstream truncated at bit ${pos}`); this.bitPos = pos; }
}
