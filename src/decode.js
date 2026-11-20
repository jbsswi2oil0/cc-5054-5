// Decoder.  Knows only the format: header fields, block syntax, quantiser
// formulas, integer transform and the documented predictors.  It has no access
// to the source image, the encoder's decisions, or any side data.
//
// Decoding follows the block order named in the header.  A block may read only
// its left and top neighbours, and only once those have been fully decoded.  If the bitstream ends inside
// a block, decoding stops and the result reports:
//   completeBlocks  - number of fully decoded blocks
//   lastComplete    - index of the last block whose every codeword was read
//   failedAt        - block index that was incomplete (-1 if none)
//   reason          - human readable cause
// Pixels of blocks that were not completed are left at the sentinel 0 and are
// flagged `decoded[j] = false`; the viewer must not display them.

import { readHeader } from "./format.js";
import { BitReader } from "./bits.js";
import { readBlock, levelsToCoeffs, readLosslessBlock } from "./syntax.js";
import { stepAt, stepGrid } from "./quant.js";
import { ZIGZAG, idct8x8 } from "./dct.js";
import { predictBlock, gatherEdges, makeEdges, BS } from "./predict.js";
import { decodeOrder } from "./encode.js";

const clamp255 = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

export function decode(bytes, opts = {}) {
  const bitLimit = opts.bitLength ?? bytes.length * 8;
  const header = readHeader(bytes); // header must be whole; throws otherwise
  const { W, H, CW, CH, qbase, lossless } = header;
  const PW = CW * BS, PH = CH * BS;
  const nBlocks = CW * CH;

  const ex = new Uint8Array(PW * PH); // padded reconstruction
  const decoded = new Uint8Array(nBlocks);
  const planes = []; // per-block reconstruction in image coordinates (8x8)
  const blocks = new Array(nBlocks);

  const r = new BitReader(bytes, bitLimit);
  r.pos = header.headerBits;
  const orderList = decodeOrder(CW, CH, header.order);
  const done = new Uint8Array(nBlocks);
  const isDone = (bx, by) => bx >= 0 && by >= 0 && bx < CW && by < CH && done[by * CW + bx] === 1;

  const predBuf = new Float64Array(64);
  const invBuf = new Float64Array(64);
  const edges = makeEdges();

  let lastComplete = -1;
  let failedAt = -1;
  let reason = "";
  let completeBlocks = 0;

  for (let oi = 0; oi < nBlocks; oi++) {
    const i = orderList[oi];
    const bx = i % CW, by = (i / CW) | 0;
    const x0 = bx * BS, y0 = by * BS;
    // a reference edge exists only once its owner has been fully decoded
    gatherEdges(ex, PW, bx, by, isDone, edges);
    const bitStart = r.pos;

    if (lossless) {
      const blk = readLosslessBlock(r);
      if (!blk) { failedAt = i; reason = "stream ended inside lossless block"; break; }
      predictBlock(blk.mode, edges, predBuf);
      const recon = new Float64Array(64);
      for (let j = 0; j < 64; j++) recon[j] = clamp255(predBuf[j] + blk.res[j]);
      for (let j = 0; j < 64; j++) {
        const rr = j >> 3, cc = j & 7;
        ex[(y0 + rr) * PW + x0 + cc] = recon[j];
      }
      planes[i] = recon;
      blocks[i] = { index: i, bx, by, qsel: 0, mode: blk.mode, k: blk.k, numAC: 64,
                    levels: blk.res, bitStart, bitEnd: r.pos,
                    ranges: blk.ranges, pred: Float64Array.from(predBuf),
                    coeffs: null, recon, lossless: true };
      decoded[i] = 1; done[i] = 1; lastComplete = i; completeBlocks++;
      continue;
    }

    const blk = readBlock(r);
    if (!blk) { failedAt = i; reason = "stream ended inside a block"; break; }
    const steps = stepGrid(qbase, blk.qsel, ZIGZAG);
    const coeffs = levelsToCoeffs(blk.levels, blk.numAC, steps);

    predictBlock(blk.mode, edges, predBuf);
    idct8x8(coeffs, invBuf);
    const recon = new Float64Array(64);
    for (let j = 0; j < 64; j++) recon[j] = clamp255(invBuf[j] + predBuf[j]);
    for (let j = 0; j < 64; j++) {
      const rr = j >> 3, cc = j & 7;
      ex[(y0 + rr) * PW + x0 + cc] = recon[j];
    }
    planes[i] = recon;
    blocks[i] = { index: i, bx, by, qsel: blk.qsel, mode: blk.mode, numAC: blk.numAC,
                  levels: blk.levels, bitStart, bitEnd: r.pos,
                  ranges: blk.ranges, pred: Float64Array.from(predBuf),
                  coeffs, recon, lossless: false };
    decoded[i] = 1; done[i] = 1; lastComplete = i; completeBlocks++;
  }

  const truncated = completeBlocks < nBlocks;
  if (truncated && failedAt >= 0) {
    reason = reason || "stream ended";
  }

  return {
    ok: !truncated,
    truncated,
    reason,
    header,
    W, H, CW, CH, PW, PH,
    completeBlocks,
    lastComplete,
    failedAt,
    bitPos: r.pos,
    bitLength: bitLimit,
    decoded,
    blocks,
    planes,
    ex,
  };
}

// Map a bit position to the block that owns it (or header / padding).
export function bitOwner(result, bitPos) {
  if (bitPos < result.header.headerBits) return { kind: "header", block: -1 };
  for (let i = 0; i < result.blocks.length; i++) {
    const b = result.blocks[i];
    if (b && bitPos >= b.bitStart && bitPos < b.bitEnd) return { kind: "block", block: i };
  }
  if (bitPos >= result.bitLength) return { kind: "end", block: -1 };
  return { kind: "unread", block: -1 };
}

// Crop the padded reconstruction into an image-plane Uint8ClampedArray.
// Pixels belonging to blocks that were not decoded are marked in `validMask`.
export function cropToImage(result) {
  const { W, H, PW, ex, decoded, CW } = result;
  const out = new Uint8ClampedArray(W * H);
  const valid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bx = (x / BS) | 0, by = (y / BS) | 0;
      if (decoded[by * CW + bx]) {
        out[y * W + x] = ex[y * PW + x];
        valid[y * W + x] = 1;
      } else {
        out[y * W + x] = 0;
        valid[y * W + x] = 0;
      }
    }
  }
  return { pixels: out, valid };
}
