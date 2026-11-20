// Quantisation steps.  Normative.
//
//   QM        base weighting matrix, QM[0][0] = 16
//   base(u,v) = max(1, round(qbase * QM[u][v] / 16))        half away from 0
//   step(u,v) = max(1, round(base(u,v) * QSEL_MULT[qsel] / 16))
//   Q         = round(F / step),  F' = Q * step
//   |F - F'| <= floor(step/2)  and 0 if F = 0
//   levels are signed integers with no format-level range limit

import { rdiv } from "./dct.js";
import { ZIGZAG } from "./dct.js";

export const QM = [
  [16, 16, 16, 16, 17, 18, 21, 24],
  [16, 16, 16, 16, 17, 19, 22, 25],
  [16, 16, 17, 17, 18, 20, 24, 28],
  [16, 16, 17, 18, 19, 22, 26, 31],
  [17, 17, 18, 19, 21, 24, 29, 35],
  [18, 19, 20, 22, 24, 28, 34, 41],
  [21, 22, 24, 26, 29, 34, 42, 50],
  [24, 25, 28, 31, 35, 41, 50, 60],
];

export const QSEL_MULT = [10, 13, 16, 22]; // 0.625, 0.8125, 1.0, 1.375
export const QSEL_SHIFT = 4;
export const QSEL_BITS = 2;

export function stepAt(u, v, qbase, qsel) {
  const base = Math.max(1, rdiv(qbase * QM[u][v], 16));
  return Math.max(1, rdiv(base * QSEL_MULT[qsel], 16));
}

export function dcStep(qbase, qsel) { return stepAt(0, 0, qbase, qsel); }

const _grid = new Int32Array(64);
export function stepGrid(qbase, qsel) {
  for (let z = 0; z < 64; z++) {
    const [u, v] = ZIGZAG[z];
    _grid[z] = stepAt(u, v, qbase, qsel);
  }
  return Int32Array.from(_grid);
}

export function quantBound(step) { return Math.floor(step / 2); }
