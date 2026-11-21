// Verified, addressable block directory for a frame indexer.
//
// The indexer may only adopt directory entries that are marked `published`.
// Publication requires three independent checks:
//
//   reparse  the block is parsed again from a fresh bounded reader covering
//            exactly [startBit,endBit).  It must consume the range exactly
//            and reproduce the same token.
//   cross    the production decoder reports the same [startBit,endBit) for
//            that block.
//   pixels   this module's reconstruction of the block equals the production
//            decoder's reconstruction.
//
// Anything failing a check is retained as `locatable` (we know where the
// block starts) but not `published` (it must not be used as a seek target).
// Seeking past a damaged tail is therefore impossible by construction.

import { parseHeader, parseBlockAt, decodeOrder, reconstruct, BitError } from "./parser.mjs";
import { decode, cropToImage } from "../../src/decode.js";
import { QM, QSEL_MULT } from "../../src/quant.js";
import { BS } from "../../src/predict.js";

function tokenEqual(a, b) {
  if (!a || !b) return false;
  if (a.lossless !== b.lossless) return false;
  if (a.mode !== b.mode) return false;
  if (a.lossless) {
    if (a.k !== b.k) return false;
    for (let j = 0; j < 64; j++) if (a.res[j] !== b.res[j]) return false;
    return true;
  }
  if (a.qsel !== b.qsel || a.numAC !== b.numAC) return false;
  for (let z = 0; z < a.numAC; z++) if (a.levels[z] !== b.levels[z]) return false;
  return true;
}

// Build the directory.  `quant` overrides the default quantiser tables.
export function buildDirectory(bytes, { bitLen = bytes.length * 8, quant } = {}) {
  const quantTables = quant || { QM, QSEL_MULT };
  const hdr = parseHeader(bytes, Math.max(bitLen, 0));
  if (hdr.error) {
    return { header: null, error: hdr.error, entries: [], published: [], truncated: true,
             publishedIndices: [] };
  }
  const header = hdr.header;
  const { CW, CH, lossless, order } = header;
  const nBlocks = CW * CH;
  const orderList = decodeOrder(CW, CH, order);
  const limit = Math.min(bitLen, bytes.length * 8);

  // Pass 1: sequential parse; record every block whose every codeword is
  // inside the available bits.
  const entries = new Array(nBlocks).fill(null);
  const tokens = new Array(nBlocks).fill(null);
  let pos = header.headerBits;
  let truncated = false;
  let failure = null;

  for (const i of orderList) {
    if (pos >= limit) {
      truncated = true;
      failure = { index: i, startBit: pos, endBit: pos, reason: "no bits for block", kind: "empty" };
      break;
    }
    try {
      const { token, end, ranges } = parseBlockAt(bytes, pos, limit, { lossless });
      entries[i] = { index: i, bx: i % CW, by: (i / CW) | 0, startBit: pos, endBit: end,
                     ranges, token, bits: end - pos, locatable: true, published: false, checks: {} };
      tokens[i] = token;
      pos = end;
    } catch (e) {
      truncated = true;
      const bitPos = Number.isInteger(e.bitPos) ? e.bitPos : pos;
      failure = {
        index: i, startBit: pos, endBit: bitPos, bitPos,
        reason: e.message, kind: e instanceof BitError ? "truncated" : "syntax",
      };
      // The block is locatable (we know where it begins) but has no token.
      entries[i] = { index: i, bx: i % CW, by: (i / CW) | 0, startBit: pos, endBit: bitPos,
                     ranges: null, token: null, bits: bitPos - pos, locatable: true,
                     published: false,
                     checks: { reparse: false, cross: false, pixels: false,
                               reasons: [`block never completed: ${e.message}`] },
                     error: e.message };
      break;
    }
  }

  // Every block the loop never reached is locatable by position but has no
  // token at all; record the same failure reason so a seek is refused with an
  // accurate explanation rather than a generic one.
  if (failure) {
    for (const i of orderList) {
      if (entries[i]) continue;
      entries[i] = { index: i, bx: i % CW, by: (i / CW) | 0, startBit: null, endBit: null,
                     ranges: null, token: null, bits: 0, locatable: false, published: false,
                     checks: { reparse: false, cross: false, pixels: false,
                               reasons: [`stream ended at block ${failure.index} before this block`] } };
    }
  }

  // Production decoder view of the same stream.
  let prod = null;
  try { prod = decode(bytes, { bitLength: bitLen }); } catch (e) { prod = { thrown: e.message }; }

  // Independent reconstruction using this parser's tokens.
  const rec = reconstruct(header, entries, bytes, quantTables);
  const prodPix = prod && !prod.thrown ? cropToImage(prod) : null;

  // Pass 2: verify and, when every check passes, publish.
  const publishedIndices = [];
  for (const i of orderList) {
    const e = entries[i];
    if (!e || !e.token) continue;
    const checks = { reparse: false, cross: false, pixels: false, reasons: [] };

    // reparse: a fresh bounded reader must consume exactly the range.
    try {
      const again = parseBlockAt(bytes, e.startBit, e.endBit, { lossless });
      checks.reparse = again.end === e.endBit && tokenEqual(again.token, e.token);
      if (!checks.reparse) checks.reasons.push("reparse did not reproduce the token");
    } catch (err) {
      checks.reparse = false;
      checks.reasons.push(`reparse failed: ${err.message}`);
    }

    // cross: the production decoder must agree on the bit range.
    if (prod && !prod.thrown && prod.blocks && prod.blocks[i]) {
      const pb = prod.blocks[i];
      checks.cross = pb.bitStart === e.startBit && pb.bitEnd === e.endBit;
      if (!checks.cross) {
        checks.reasons.push(`production range [${pb.bitStart},${pb.bitEnd}) != [${e.startBit},${e.endBit})`);
      }
    } else {
      checks.reasons.push("production decoder did not yield this block");
    }

    // pixels: per-block reconstruction must match the production decoder.
    if (prodPix && rec.out[i]) {
      const mine = rec.out[i].recon;
      const { bx, by } = e;
      let ok = true;
      for (let r = 0; r < 8 && ok; r++) {
        for (let c = 0; c < 8; c++) {
          const gx = bx * BS + c, gy = by * BS + r;
          if (gx >= prod.W || gy >= prod.H) continue;
          if (prodPix.valid[gy * prod.W + gx]) {
            if (prodPix.pixels[gy * prod.W + gx] !== clamp(mine[r * 8 + c])) { ok = false; break; }
          }
        }
      }
      checks.pixels = ok;
      if (!ok) checks.reasons.push("reconstruction differs from the production decoder");
    } else {
      checks.reasons.push("no production pixels for comparison");
    }

    e.checks = checks;
    e.published = checks.reparse && checks.cross && checks.pixels;
    if (e.published) publishedIndices.push(i);
    else if (!checks.reasons.length) checks.reasons.push("unpublished");
  }

  const published = orderList.filter((i) => entries[i] && entries[i].published);

  return {
    header, entries, orderList, failure, truncated,
    published, publishedIndices,
    bitLength: limit, totalBits: pos,
    prod,
  };
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// Compact directory suitable for handing to a frame indexer.  Only published
// entries appear in `entries`; every published entry names its exact bit span.
export function seekDirectory(dir) {
  const h = dir.header;
  return {
    format: "IVC1",
    W: h ? h.W : null, H: h ? h.H : null,
    grid: h ? `${h.CW}x${h.CH}` : null,
    order: h ? h.order : null,
    bitLength: dir.bitLength,
    complete: !dir.truncated && dir.published.length === h.CW * h.CH,
    publishedCount: dir.published.length,
    entries: dir.published.map((i) => {
      const e = dir.entries[i];
      return { block: i, bx: e.bx, by: e.by, startBit: e.startBit, endBit: e.endBit,
               bytes: (e.endBit + 7) >> 3, mode: e.token.mode, qsel: e.token.qsel ?? 0,
               numAC: e.token.numAC ?? 64 };
    }),
    tail: dir.failure ? { locatable: true, published: false, ...dir.failure } : null,
  };
}

// Random-access read of a single block through the directory.  Only published
// entries are addressable; asking for an unpublished block is an error, which
// is what stops an indexer from presenting an unverified tail as a seek point.
//
// Returns the parsed token and the exact bytes that were touched.
export function seekBlock(bytes, dir, blockIndex) {
  const e = dir.entries[blockIndex];
  if (!e) throw new Error(`block ${blockIndex} not in directory`);
  if (!e.published) throw new Error(`block ${blockIndex} is locatable but not published: ` +
    (e.checks && e.checks.reasons ? e.checks.reasons.join("; ") : "unverified"));
  const need = (e.endBit + 7) >> 3;
  if (bytes.length < need) throw new Error(`stream shorter than directory requires for block ${blockIndex}`);
  // Read only the bytes covering this block; the parser is bounded to the
  // block's exact bit range, so a seek does not depend on earlier blocks.
  const firstByte = e.startBit >> 3;
  const chunk = bytes.slice(firstByte, need);
  const localStart = e.startBit - firstByte * 8;
  const { token, end, ranges } = parseBlockAt(chunk, localStart, localStart + (e.endBit - e.startBit),
    { lossless: !!dir.header.lossless });
  if (end - localStart !== e.endBit - e.startBit) throw new Error(`block ${blockIndex} did not consume its exact range`);
  return { token, ranges, bitStart: e.startBit, bitEnd: e.endBit,
           bytesTouched: { firstByte, lastByte: need - 1, count: need - firstByte } };
}
