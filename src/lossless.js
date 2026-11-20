// Integer reversible 8x8 block transform (lifting, WHT-like).
//
// The forward transform is exactly invertible in integer arithmetic, so the
// lossless path can transmit transform coefficients rather than raw residuals
// and still reconstruct bit-exactly.
//
// Forward (applied to the 8x8 residual block, rows then columns):
//   a = x0 - x7, b = x1 - x6, c = x2 - x5, d = x3 - x4
//   e = x0 + x7, f = x1 + x6, g = x2 + x5, h = x3 + x4
//   out0 = e+f, out1 = g+h, out2 = e-f, out3 = g-h,
//   out4 = a+b, out5 = c+d, out6 = a-b, out7 = c-d
// This is an orthogonal integer matrix up to a scale of 2 per stage, and the
// inverse is the algebraically exact reverse (each stage adds with shifts and
// halves without rounding loss because the forward sums keep the parity).
//
// Coefficients are reordered by the standard 2D hierarchical order, then
// scanned with the same zig-zag as the DCT path.

export function fwdBlock(x, out) {
  // rows
  const tmp = new Float64Array(64);
  for (let r = 0; r < 8; r++) {
    const o = r * 8;
    const x0 = x[o], x1 = x[o + 1], x2 = x[o + 2], x3 = x[o + 3];
    const x4 = x[o + 4], x5 = x[o + 5], x6 = x[o + 6], x7 = x[o + 7];
    const a = x0 - x7, b = x1 - x6, c = x2 - x5, d = x3 - x4;
    const e = x0 + x7, f = x1 + x6, g = x2 + x5, h = x3 + x4;
    tmp[o + 0] = e + f; tmp[o + 1] = g + h; tmp[o + 2] = e - f; tmp[o + 3] = g - h;
    tmp[o + 4] = a + b; tmp[o + 5] = c + d; tmp[o + 6] = a - b; tmp[o + 7] = c - d;
  }
  // columns, written to out in natural (row-major) order
  for (let c = 0; c < 8; c++) {
    const y0 = tmp[0 * 8 + c], y1 = tmp[1 * 8 + c], y2 = tmp[2 * 8 + c], y3 = tmp[3 * 8 + c];
    const y4 = tmp[4 * 8 + c], y5 = tmp[5 * 8 + c], y6 = tmp[6 * 8 + c], y7 = tmp[7 * 8 + c];
    const a = y0 - y7, b = y1 - y6, cc = y2 - y5, d = y3 - y4;
    const e = y0 + y7, f = y1 + y6, g = y2 + y5, h = y3 + y4;
    out[0 * 8 + c] = e + f; out[1 * 8 + c] = g + h; out[2 * 8 + c] = e - f; out[3 * 8 + c] = g - h;
    out[4 * 8 + c] = a + b; out[5 * 8 + c] = cc + d; out[6 * 8 + c] = a - b; out[7 * 8 + c] = cc - d;
  }
  return out;
}

export function invBlock(y, out) {
  // inverse columns first (forward did rows then columns, so undo columns)
  const tmp = new Float64Array(64);
  for (let c = 0; c < 8; c++) {
    const s0 = y[0 * 8 + c], s1 = y[1 * 8 + c], s2 = y[2 * 8 + c], s3 = y[3 * 8 + c];
    const s4 = y[4 * 8 + c], s5 = y[5 * 8 + c], s6 = y[6 * 8 + c], s7 = y[7 * 8 + c];
    const e = (s0 + s2) >> 1, f = (s0 - s2) >> 1;
    const g = (s1 + s3) >> 1, h = (s1 - s3) >> 1;
    const a = (s4 + s6) >> 1, b = (s4 - s6) >> 1;
    const cc = (s5 + s7) >> 1, d = (s5 - s7) >> 1;
    tmp[0 * 8 + c] = (e + a) >> 1; tmp[7 * 8 + c] = (e - a) >> 1;
    tmp[1 * 8 + c] = (f + b) >> 1; tmp[6 * 8 + c] = (f - b) >> 1;
    tmp[2 * 8 + c] = (g + cc) >> 1; tmp[5 * 8 + c] = (g - cc) >> 1;
    tmp[3 * 8 + c] = (h + d) >> 1; tmp[4 * 8 + c] = (h - d) >> 1;
  }
  // inverse rows
  for (let r = 0; r < 8; r++) {
    const o = r * 8;
    const s0 = tmp[o + 0], s1 = tmp[o + 1], s2 = tmp[o + 2], s3 = tmp[o + 3];
    const s4 = tmp[o + 4], s5 = tmp[o + 5], s6 = tmp[o + 6], s7 = tmp[o + 7];
    const e = (s0 + s2) >> 1, f = (s0 - s2) >> 1;
    const g = (s1 + s3) >> 1, h = (s1 - s3) >> 1;
    const a = (s4 + s6) >> 1, b = (s4 - s6) >> 1;
    const cc = (s5 + s7) >> 1, d = (s5 - s7) >> 1;
    out[o + 0] = (e + a) >> 1; out[o + 7] = (e - a) >> 1;
    out[o + 1] = (f + b) >> 1; out[o + 6] = (f - b) >> 1;
    out[o + 2] = (g + cc) >> 1; out[o + 5] = (g - cc) >> 1;
    out[o + 3] = (h + d) >> 1; out[o + 4] = (h - d) >> 1;
  }
  return out;
}
