// Integer 8x8 DCT-II / inverse DCT, fixed point, deterministic.
//
// C[u][x] = round(512 * a(u) * cos((2x+1)u*pi/16))
// Forward : F[u][v] = round( sum_y sum_x C[u][y] * X[y][x] * C[v][x] / 2^21 )
// Inverse : X[y][x] = round( sum_u sum_v C[u][y] * F[u][v] * C[v][x] / 2^15 )
//
// Both are evaluated separably (rows, then columns) but with a single final
// rounding, so they are bit-identical to the direct double sum.  The scaling
// is chosen so that the DC coefficient of a constant block is exactly the
// constant, which makes flat blocks reconstruct exactly at qbase 1.
// With qbase 1 every step is 1 and no coefficient is quantised away; the only
// error left is the transform's own rounding (see SPEC.md section 5.3).

export const DCT_C = [
  [181, 181, 181, 181, 181, 181, 181, 181],
  [251, 213, 142, 50, -50, -142, -213, -251],
  [237, 98, -98, -237, -237, -98, 98, 237],
  [213, -50, -251, -142, 142, 251, 50, -213],
  [181, -181, -181, 181, 181, -181, -181, 181],
  [142, -251, 50, 213, -213, -50, 251, -142],
  [98, -237, 237, -98, -98, 237, -237, 98],
  [50, -142, 213, -251, 251, -213, 142, -50],
];

export const FWD_SHIFT = 21;
export const INV_SHIFT = 15;

// round-half-away-from-zero division, exact for the magnitudes used here.
export function rdiv(a, b) {
  return a >= 0 ? Math.floor((a + b / 2) / b) : -Math.floor((-a + b / 2) / b);
}

// blocks: Uint8ClampedArray(64) or array of 64 numbers, row major.
// out: Float64Array(64) of integer coefficients, also row major.
export function fdct8x8(block, out = new Float64Array(64)) {
  const C = DCT_C;
  const tmp = fdct8x8._tmp || (fdct8x8._tmp = new Float64Array(64));
  // rows: tmp[u*8+x] = sum_y C[u][y] * X[y][x]
  for (let u = 0; u < 8; u++) {
    const cu = C[u];
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += cu[y] * block[y * 8 + x];
      tmp[u * 8 + x] = s;
    }
  }
  const den = 1 << FWD_SHIFT;
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      const cv = C[v];
      let s = 0;
      for (let x = 0; x < 8; x++) s += tmp[u * 8 + x] * cv[x];
      out[u * 8 + v] = rdiv(s, den);
    }
  }
  return out;
}

// coeffs: Float64Array(64) integer coefficients, row major.
// out: Float64Array(64) integer pixels (not clamped).
export function idct8x8(coeffs, out = new Float64Array(64)) {
  const C = DCT_C;
  const tmp = idct8x8._tmp || (idct8x8._tmp = new Float64Array(64));
  // tmp[y*8+v] = sum_u C[u][y] * F[u][v]
  for (let y = 0; y < 8; y++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += C[u][y] * coeffs[u * 8 + v];
      tmp[y * 8 + v] = s;
    }
  }
  const den = 1 << INV_SHIFT;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[y * 8 + v] * C[v][x];
      out[y * 8 + x] = rdiv(s, den);
    }
  }
  return out;
}

// Zig-zag scan order: index -> (row u, col v).
export const ZIGZAG = [
  [0, 0], [0, 1], [1, 0], [2, 0], [1, 1], [0, 2], [0, 3], [1, 2],
  [2, 1], [3, 0], [4, 0], [3, 1], [2, 2], [1, 3], [0, 4], [0, 5],
  [1, 4], [2, 3], [3, 2], [4, 1], [5, 0], [6, 0], [5, 1], [4, 2],
  [3, 3], [2, 4], [1, 5], [0, 6], [0, 7], [1, 6], [2, 5], [3, 4],
  [4, 3], [5, 2], [6, 1], [7, 0], [7, 1], [6, 2], [5, 3], [4, 4],
  [3, 5], [2, 6], [1, 7], [2, 7], [3, 6], [4, 5], [5, 4], [6, 3],
  [7, 2], [7, 3], [6, 4], [5, 5], [4, 6], [3, 7], [4, 7], [5, 6],
  [6, 5], [7, 4], [7, 5], [6, 6], [5, 7], [6, 7], [7, 6], [7, 7],
];

export function blockToZigzag(coeffsRowMajor, out = new Float64Array(64)) {
  for (let z = 0; z < 64; z++) {
    const [u, v] = ZIGZAG[z];
    out[z] = coeffsRowMajor[u * 8 + v];
  }
  return out;
}

export function zigzagToBlock(coeffsZigzag, out = new Float64Array(64)) {
  for (let z = 0; z < 64; z++) {
    const [u, v] = ZIGZAG[z];
    out[u * 8 + v] = coeffsZigzag[z];
  }
  return out;
}
