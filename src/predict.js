// Intra prediction from previously reconstructed edges only.
//
// The predictor is a pure function of explicit edge arrays, so the encoder can
// ask "what would the neighbour see if this block produced that edge?" without
// inventing a second implementation.
//
//   L[i]  eight samples of the column immediately left of the block
//   T[i]  eight samples of the row immediately above the block
//   C     the sample diagonally above-left
// hasL / hasT decide availability; when false the corresponding array is not
// read at all.
//
// Slopes use Q6:  s = round(d*64/7), half away from zero.
//   D_TOP  P(r,c) = T[c] + rdiv64(sL*r)
//   D_LEFT P(r,c) = L[r] + rdiv64(sT*c)
//   CORNER P(r,c) = T[c] + L[r] - C
// Predictions are integers and are NOT clamped; the reconstruction is.
//
// Fallbacks (also used for the first block row and column):
//   DC     mean of the available edges, else 128
//   H      left, else top, else 128
//   V      top, else left, else 128
//   D_TOP  top; slope from left if it exists, else from the top edge;
//          without a top edge it behaves as H
//   D_LEFT left; slope from top if it exists, else from the left edge;
//          without a left edge it behaves as V
//   CORNER T[c]+L[r]-C, else V, else H, else 128

export const BS = 8;
export const MODES = ["RAW", "DC", "H", "V", "D_TOP", "D_LEFT", "CORNER"];
export const MODE_BITS = 3;

function rdiv64(a) {
  return a >= 0 ? Math.floor((a + 32) / 64) : -Math.floor((-a + 32) / 64);
}
function rdivN(a, n) {
  return a >= 0 ? Math.floor((a + (n >> 1)) / n) : -Math.floor((-a + (n >> 1)) / n);
}
function slopeQ6(d) {
  return d >= 0 ? Math.floor((d * 64 + 3) / 7) : -Math.floor((-d * 64 + 3) / 7);
}

// Scratch edge set.  Callers reuse one instance to avoid allocation churn.
export function makeEdges() {
  return { L: new Float64Array(8), T: new Float64Array(8), C: 0, hasL: false, hasT: false };
}

// Gather the edges of block (bx,by) from a padded reconstruction canvas.
// `ready(bx,by)` must report whether that block has been decoded.
export function gatherEdges(canvas, PW, bx, by, ready, out) {
  const hasL = bx > 0 && ready(bx - 1, by);
  const hasT = by > 0 && ready(bx, by - 1);
  out.hasL = hasL;
  out.hasT = hasT;
  const x0 = bx * BS, y0 = by * BS;
  if (hasL) for (let i = 0; i < 8; i++) out.L[i] = canvas[(y0 + i) * PW + x0 - 1];
  if (hasT) for (let i = 0; i < 8; i++) out.T[i] = canvas[(y0 - 1) * PW + x0 + i];
  out.C = (hasL && hasT) ? canvas[(y0 - 1) * PW + x0 - 1] : 0;
  return out;
}

export function predictBlock(mode, e, out) {
  const { L, T, C, hasL, hasT } = e;
  switch (mode) {
    case 0:
      out.fill(128); return out;
    case 1: {
      let s = 0, n = 0;
      if (hasL) for (let i = 0; i < 8; i++) { s += L[i]; n++; }
      if (hasT) for (let i = 0; i < 8; i++) { s += T[i]; n++; }
      out.fill(n ? rdivN(s, n) : 128); return out;
    }
    case 2: {
      if (hasL) { for (let r = 0; r < 8; r++) { const v = L[r]; for (let c = 0; c < 8; c++) out[r * 8 + c] = v; } return out; }
      if (hasT) { for (let c = 0; c < 8; c++) { const v = T[c]; for (let r = 0; r < 8; r++) out[r * 8 + c] = v; } return out; }
      out.fill(128); return out;
    }
    case 3: {
      if (hasT) { for (let c = 0; c < 8; c++) { const v = T[c]; for (let r = 0; r < 8; r++) out[r * 8 + c] = v; } return out; }
      if (hasL) { for (let r = 0; r < 8; r++) { const v = L[r]; for (let c = 0; c < 8; c++) out[r * 8 + c] = v; } return out; }
      out.fill(128); return out;
    }
    case 4: {
      if (hasT) {
        const slope = slopeQ6(hasL ? L[7] - L[0] : T[7] - T[0]);
        for (let c = 0; c < 8; c++) { const base = T[c]; for (let r = 0; r < 8; r++) out[r * 8 + c] = base + rdiv64(slope * r); }
        return out;
      }
      if (hasL) { for (let r = 0; r < 8; r++) { const v = L[r]; for (let c = 0; c < 8; c++) out[r * 8 + c] = v; } return out; }
      out.fill(128); return out;
    }
    case 5: {
      if (hasL) {
        const slope = slopeQ6(hasT ? T[7] - T[0] : L[7] - L[0]);
        for (let r = 0; r < 8; r++) { const base = L[r]; for (let c = 0; c < 8; c++) out[r * 8 + c] = base + rdiv64(slope * c); }
        return out;
      }
      if (hasT) { for (let c = 0; c < 8; c++) { const v = T[c]; for (let r = 0; r < 8; r++) out[r * 8 + c] = v; } return out; }
      out.fill(128); return out;
    }
    case 6: {
      if (hasL && hasT) {
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) out[r * 8 + c] = T[c] + L[r] - C;
        return out;
      }
      if (hasT) { for (let c = 0; c < 8; c++) { const v = T[c]; for (let r = 0; r < 8; r++) out[r * 8 + c] = v; } return out; }
      if (hasL) { for (let r = 0; r < 8; r++) { const v = L[r]; for (let c = 0; c < 8; c++) out[r * 8 + c] = v; } return out; }
      out.fill(128); return out;
    }
    default:
      out.fill(128); return out;
  }
}
