// Encoder.  Produces a self-describing bitstream and a trace that maps every
// block to its bit range and to its reconstructed pixels.
//
// The encoder obeys the same causality rule as the decoder: a block's
// prediction may only read edges whose owner block has already been decoded
// in the chosen order.  The source image is used only to measure error.
//
// Selection strategies
//   "local"  argmin over (qsel, mode) of this block's own SSE; real codeword
//            lengths break ties.
//   "chain"  argmin of  own SSE + lambda * sum_neighbours (edge damage)
//            where the edge damage of the right neighbour is recomputed
//            exactly: the neighbour's own best residual is re-quantised and
//            re-reconstructed from a prediction built with this block's
//            candidate edge, and the increase in its SSE is measured.  The
//            bottom neighbour is handled the same way.  This is a real
//            measurement of the error handed to the next block, not a proxy.
//
// Both stages use the actual decoder predictor on explicit edge arrays, and
// the actual codeword lengths (EG0 of every transmitted level).

import { BitWriter } from "./bits.js";
import { fdct8x8, idct8x8, blockToZigzag, zigzagToBlock, ZIGZAG, rdiv } from "./dct.js";
import { stepGrid } from "./quant.js";
import { predictBlock, makeEdges, gatherEdges, MODES, BS } from "./predict.js";
import { writeBlock, writeLosslessBlock, riceLength } from "./syntax.js";
import { eg0Length, mapSigned } from "./codes.js";
import { buildHeader, writeHeader } from "./format.js";

export const STRATEGIES = ["local", "chain"];
export const ORDERS = ["raster", "wavefront", "column"];

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const levelBits = (v) => eg0Length(mapSigned(v));

function tokenBits(levels, numAC) {
  let bits = 2 + 3 + eg0Length(numAC - 1);
  for (let z = 0; z < numAC; z++) bits += levelBits(levels[z]);
  return bits;
}
// Rice cost of a block with parameter k (3 mode bits + 4 k bits excluded
// when comparing parameters; they are constant across k).
function riceCost(res, k) {
  let bits = 0;
  for (let j = 0; j < 64; j++) bits += riceLength(mapSigned(res[j]), k);
  return bits;
}
function bestRiceK(res) {
  let bestK = 0, best = Infinity;
  for (let k = 0; k <= 15; k++) {
    const c = riceCost(res, k);
    if (c < best) { best = c; bestK = k; }
  }
  return { k: bestK, bits: best + 7 };
}

// Block decode order.  Every entry is a linear extension of "left and top
// first", so the causal availability predicate never has to look ahead.
export function decodeOrder(CW, CH, order) {
  const list = [];
  if (order === "raster") {
    for (let i = 0; i < CW * CH; i++) list.push(i);
  } else if (order === "wavefront") {
    for (let d = 0; d <= CW + CH - 2; d++)
      for (let by = Math.max(0, d - (CW - 1)); by <= Math.min(CH - 1, d); by++)
        list.push(by * CW + (d - by));
  } else if (order === "column") {
    for (let bx = 0; bx < CW; bx++)
      for (let by = 0; by < CH; by++) list.push(by * CW + bx);
  } else {
    throw new Error(`unknown order ${order}`);
  }
  return list;
}

export function orderRank(CW, CH, order) {
  const list = decodeOrder(CW, CH, order);
  const rank = new Int32Array(CW * CH);
  for (let k = 0; k < list.length; k++) rank[list[k]] = k;
  return { list, rank };
}

export function encode(gray, W, H, opts = {}) {
  const qbase = opts.qbase ?? 16;
  const strategy = opts.strategy ?? "local";
  const order = opts.order ?? "raster";
  const lossless = !!opts.lossless;
  const recordTrace = opts.trace !== false;
  const lambda = opts.lambda ?? 0.5;
  if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy ${strategy}`);
  if (!ORDERS.includes(order)) throw new Error(`unknown order ${order}`);
  if (lossless && strategy !== "local") throw new Error("lossless has no chain strategy");

  const CW = Math.ceil(W / BS), CH = Math.ceil(H / BS);
  const PW = CW * BS, PH = CH * BS;
  const nBlocks = CW * CH;
  const { list: orderList, rank } = orderRank(CW, CH, order);
  const decoded = new Uint8Array(nBlocks);
  const ready = (bx, by) => bx >= 0 && by >= 0 && bx < CW && by < CH && decoded[by * CW + bx] === 1;

  // padded source: replicate the last real sample (padding is never displayed)
  const src = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    const sy = y < H ? y : H - 1;
    for (let x = 0; x < PW; x++) src[y * PW + x] = gray[sy * W + (x < W ? x : W - 1)];
  }

  // ---- block model --------------------------------------------------------
  // A candidate is fully described by: prediction, quantised zig-zag levels,
  // scan length, and the reconstruction it produces on the padded canvas.
  function encodeBlock(edges, bx, by, mode, qsel) {
    const x0 = bx * BS, y0 = by * BS;
    const pred = new Float64Array(64);
    predictBlock(mode, edges, pred);
    const res = new Float64Array(64);
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        res[r * 8 + c] = src[(y0 + r) * PW + x0 + c] - pred[r * 8 + c];
    const recon = new Float64Array(64);

    if (lossless) {
      // exact residual, Rice coded with the best parameter for this block
      const lv = new Int32Array(64);
      for (let j = 0; j < 64; j++) lv[j] = Math.round(res[j]);
      const { k, bits } = bestRiceK(lv);
      for (let j = 0; j < 64; j++) recon[j] = clamp255(pred[j] + lv[j]);
      // reconstruction is exact by construction; sse is 0 unless the signal
      // plus prediction leaves [0,255] (it cannot, residual is defined on src)
      let sse = 0;
      for (let j = 0; j < 64; j++) { const e = recon[j] - src[(y0 + (j >> 3)) * PW + x0 + (j & 7)]; sse += e * e; }
      return { mode, qsel: 0, sse, bits, k, numAC: 64, levels: lv,
               recon, pred, coeffs: null };
    }

    const coeff = fdct8x8(res);
    const zz = blockToZigzag(coeff);
    const steps = stepGrid(qbase, qsel);
    const levels = new Int32Array(64);
    for (let z = 0; z < 64; z++) levels[z] = rdiv(zz[z], steps[z]);
    let numAC = 64;
    while (numAC > 1 && levels[numAC - 1] === 0) numAC--;
    const q = new Float64Array(64);
    for (let z = 0; z < numAC; z++) {
      const [u, v] = ZIGZAG[z];
      q[u * 8 + v] = levels[z] * steps[z];
    }
    const inv = idct8x8(q);
    let sse = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = clamp255(Math.round(inv[r * 8 + c] + pred[r * 8 + c]));
        recon[r * 8 + c] = v;
        const e = v - src[(y0 + r) * PW + x0 + c];
        sse += e * e;
      }
    }
    return { mode, qsel, sse, bits: tokenBits(levels, numAC), numAC, levels, recon, pred, coeffs: q };
  }

  const better = (a, b) =>
    a.sse !== b.sse ? a.sse < b.sse
    : a.bits !== b.bits ? a.bits < b.bits
    : a.qsel !== b.qsel ? a.qsel < b.qsel
    : a.mode < b.mode;

  function search(edges, bx, by) {
    let best = null;
    for (let qsel = 0; qsel < 4; qsel++)
      for (let mode = 0; mode < MODES.length; mode++) {
        const c = encodeBlock(edges, bx, by, mode, qsel);
        if (!best || better(c, best)) best = c;
      }
    return best;
  }

  // A compact edge set the way a neighbour would see it.
  function edgeSetFromCanvas(canvas, bx, by, readyFn, out) {
    return gatherEdges(canvas, PW, bx, by, readyFn, out);
  }

  // ---- stage A: local optimum with ideal edges ----------------------------
  const ideal = new Uint8Array(PW * PH);
  const localSSE = new Float64Array(nBlocks);
  const localBits = new Float64Array(nBlocks);
  const localCand = new Array(nBlocks);
  const allReady = () => true;
  const eA = makeEdges();
  decoded.fill(1);
  for (const i of orderList) {
    const bx = i % CW, by = (i / CW) | 0;
    edgeSetFromCanvas(ideal, bx, by, ready, eA);
    const best = search(eA, bx, by);
    localSSE[i] = best.sse;
    localBits[i] = best.bits;
    localCand[i] = best;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        ideal[(by * 8 + r) * PW + bx * 8 + c] = best.recon[r * 8 + c];
  }

  // ---- stage B: replay the real decode order ------------------------------
  const rec = new Uint8Array(PW * PH);
  const chosen = new Array(nBlocks);
  const eB = makeEdges();
  const eN = makeEdges();
  decoded.fill(0);

  for (const i of orderList) {
    const bx = i % CW, by = (i / CW) | 0;
    edgeSetFromCanvas(rec, bx, by, ready, eB);

    const cands = [];
    for (let qsel = 0; qsel < 4; qsel++)
      for (let mode = 0; mode < MODES.length; mode++)
        cands.push(encodeBlock(eB, bx, by, mode, qsel));

    let best = cands[0];
    for (const c of cands) if (better(c, best)) best = c;

    if (strategy === "chain") {
      // Neighbours that are decoded after this block and therefore inherit
      // this block's edge: under the causal orders these are the right and
      // bottom blocks, which are always later in the order.
      const nbs = [];
      if (bx + 1 < CW) nbs.push({ bx: bx + 1, by, side: "R" });
      if (by + 1 < CH) nbs.push({ bx, by: by + 1, side: "B" });

      // Their local-optimum loss, measured with the ideal edge, is the
      // reference "damage" caused by an edge.
      let pick = null;
      for (const c of cands) {
        let damage = 0;
        for (const n of nbs) {
          const ni = n.by * CW + n.bx;
          // Re-predict the neighbour with this candidate's shared edge while
          // holding its other edge at the local-optimum reference.  The held
          // edge is identical for every candidate, so it cancels out of the
          // comparison and the measured delta is attributable to this block.
          const nEdge = makeEdges();
          if (n.side === "R") {
            nEdge.hasL = true;                    // our right column
            for (let r = 0; r < 8; r++) nEdge.L[r] = c.recon[r * 8 + 7];
            if (n.by > 0) {
              nEdge.hasT = true;                  // held reference
              for (let k = 0; k < 8; k++) nEdge.T[k] = ideal[((n.by - 1) * 8) * PW + n.bx * 8 + k];
              nEdge.C = ideal[((n.by - 1) * 8 + 7) * PW + n.bx * 8 - 1];
            }
          } else {
            nEdge.hasT = true;                    // our bottom row
            for (let k = 0; k < 8; k++) nEdge.T[k] = c.recon[7 * 8 + k];
            if (n.bx > 0) {
              nEdge.hasL = true;                  // held reference
              for (let r = 0; r < 8; r++) nEdge.L[r] = ideal[(n.by * 8 + r) * PW + n.bx * 8 - 1];
              nEdge.C = ideal[(n.by * 8 - 1) * PW + n.bx * 8 - 1];
            }
          }
          // let the neighbour re-select its own best mode under this edge,
          // so the damage is what it truly cannot avoid
          const alt = searchForNeighbour(nEdge, n.bx, n.by);
          damage += Math.max(0, alt.sse - localSSE[ni]);
        }
        const score = c.sse + lambda * damage;
        if (!pick || score < pick.score || (score === pick.score && better(c, pick.c)))
          pick = { c, score };
      }
      best = pick.c;
    }

    chosen[i] = best;
    decoded[i] = 1;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        rec[(by * 8 + r) * PW + bx * 8 + c] = best.recon[r * 8 + c];
  }

  // Neighbour search under a modified edge: the neighbour is free to pick a
  // different mode/qsel, which is exactly what the decoder will do.
  function searchForNeighbour(edges, bx, by) { return search(edges, bx, by); }

  // ---- emit ---------------------------------------------------------------
  const w = new BitWriter();
  const header = buildHeader({ W, H, qbase, lossless, strategy, order });
  writeHeader(w, header);
  const headerBits = w.pos;

  const blocks = new Array(nBlocks);
  for (const i of orderList) {
    const b = chosen[i];
    let ranges;
    if (lossless) {
      ranges = writeLosslessBlock(w, { mode: b.mode, k: b.k, res: b.levels });
      blocks[i] = { index: i, bx: i % CW, by: (i / CW) | 0, qsel: 0, mode: b.mode, k: b.k,
                    numAC: 64, levels: b.levels, pred: b.pred, coeffs: null,
                    recon: b.recon, bitStart: ranges.mode.start, bitEnd: ranges.end,
                    ranges, sse: b.sse, bits: b.bits, lossless: true };
    } else {
      ranges = writeBlock(w, { qsel: b.qsel, mode: b.mode, numAC: b.numAC, levels: b.levels });
      blocks[i] = { index: i, bx: i % CW, by: (i / CW) | 0, qsel: b.qsel, mode: b.mode,
                    numAC: b.numAC, levels: b.levels, pred: b.pred, coeffs: b.coeffs,
                    recon: b.recon, bitStart: ranges.qsel.start, bitEnd: ranges.end,
                    ranges, sse: b.sse, bits: b.bits, lossless: false };
    }
  }
  const bytes = w.finish();
  const totalBits = w.pos;
  const padding = (8 - (totalBits % 8)) % 8;

  const trace = recordTrace ? {
    W, H, CW, CH, PW, PH, qbase, order, strategy, lossless,
    headerBits, totalBits, byteLength: bytes.length, paddingBits: padding,
    blocks, order: orderList, rank, localSSE, localBits, lambda,
  } : null;
  return { bytes, header, trace, totalBits, W, H, qbase, lossless, strategy, order };
}
