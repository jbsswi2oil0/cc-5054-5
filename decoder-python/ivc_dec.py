#!/usr/bin/env python3
"""Independent reference decoder for the IVC1 format.

This file was written from SPEC.md alone and shares no code with the
JavaScript implementation.  It exists to prove the format description is
complete: any discrepancy between this decoder and the JS decoder is a bug in
the *specification*, not a decoder quirk.

Usage:
    python3 decoder-python/ivc_dec.py in.ivc out.pgm [--bits N]

Outputs a P5 PGM.  Pixels belonging to blocks that the truncated stream does
not fully determine are written as 0, and the decoder prints the last fully
determined block and the reason.
"""

import sys
import math

MAGIC = 0x49564331
VERSION = 1
HEADER_BITS = 79

C = [
    [181, 181, 181, 181, 181, 181, 181, 181],
    [251, 213, 142, 50, -50, -142, -213, -251],
    [237, 98, -98, -237, -237, -98, 98, 237],
    [213, -50, -251, -142, 142, 251, 50, -213],
    [181, -181, -181, 181, 181, -181, -181, 181],
    [142, -251, 50, 213, -213, -50, 251, -142],
    [98, -237, 237, -98, -98, 237, -237, 98],
    [50, -142, 213, -251, 251, -213, 142, -50],
]
FWD_SHIFT = 20
INV_SHIFT = 16

QM = [
    [16, 16, 16, 16, 17, 18, 21, 24],
    [16, 16, 16, 16, 17, 19, 22, 25],
    [16, 16, 17, 17, 18, 20, 24, 28],
    [16, 16, 17, 18, 19, 22, 26, 31],
    [17, 17, 18, 19, 21, 24, 29, 35],
    [18, 19, 20, 22, 24, 28, 34, 41],
    [21, 22, 24, 26, 29, 34, 42, 50],
    [24, 25, 28, 31, 35, 41, 50, 60],
]
QSEL_MULT = [10, 13, 16, 22]

ZIGZAG = [
    (0, 0), (0, 1), (1, 0), (2, 0), (1, 1), (0, 2), (0, 3), (1, 2),
    (2, 1), (3, 0), (4, 0), (3, 1), (2, 2), (1, 3), (0, 4), (0, 5),
    (1, 4), (2, 3), (3, 2), (4, 1), (5, 0), (6, 0), (5, 1), (4, 2),
    (3, 3), (2, 4), (1, 5), (0, 6), (0, 7), (1, 6), (2, 5), (3, 4),
    (4, 3), (5, 2), (6, 1), (7, 0), (7, 1), (6, 2), (5, 3), (4, 4),
    (3, 5), (2, 6), (1, 7), (2, 7), (3, 6), (4, 5), (5, 4), (6, 3),
    (7, 2), (7, 3), (6, 4), (5, 5), (4, 6), (3, 7), (4, 7), (5, 6),
    (6, 5), (7, 4), (7, 5), (6, 6), (5, 7), (6, 7), (7, 6), (7, 7),
]


def rdiv(a, b):
    """round half away from zero"""
    if a >= 0:
        return (a + b // 2) // b
    return -((-a + b // 2) // b)


class Truncated(Exception):
    pass


class Bits:
    def __init__(self, data, bit_len):
        self.data = data
        self.n = bit_len
        self.pos = 0

    def bit(self):
        if self.pos >= self.n:
            raise Truncated()
        b = (self.data[self.pos >> 3] >> (7 - (self.pos & 7))) & 1
        self.pos += 1
        return b

    def read(self, k):
        v = 0
        for _ in range(k):
            v = (v << 1) | self.bit()
        return v

    def eg0(self):
        zeros = 0
        while self.bit() == 0:
            zeros += 1
            if zeros > 31:
                raise ValueError("EG0 overflow")
        k = 0
        for _ in range(zeros):
            k = (k << 1) | self.bit()
        return k

    def eg0s(self):
        k = self.eg0()
        return (k + 1) // 2 if (k & 1) else -(k // 2)

    def rice(self, k):
        q = 0
        while self.bit() == 0:
            q += 1
            if q >= (1 << 30):
                raise ValueError("Rice quotient overflow")
        u = q << k
        if k > 0:
            u |= self.read(k)
        return u


def parse_header(b):
    magic = b.read(32)
    if magic != MAGIC:
        raise ValueError("bad magic 0x%08x" % magic)
    version = b.read(4)
    if version != VERSION:
        raise ValueError("bad version %d" % version)
    W = b.read(12) + 1
    H = b.read(12) + 1
    qbase = b.read(8) + 1
    lossless = b.read(1)
    order_code = b.read(2)
    hint = b.read(1)
    reserved = b.read(7)
    if reserved != 0:
        raise ValueError("reserved bits set")
    if order_code > 2:
        raise ValueError("bad order")
    return dict(W=W, H=H, qbase=qbase, lossless=lossless,
                order=["raster", "wavefront", "column"][order_code],
                hint=hint)


def decode_order(CW, CH, order):
    out = []
    if order == "raster":
        out = list(range(CW * CH))
    elif order == "wavefront":
        for d in range(CW + CH - 1):
            for by in range(max(0, d - (CW - 1)), min(CH - 1, d) + 1):
                out.append(by * CW + (d - by))
    else:
        for bx in range(CW):
            for by in range(CH):
                out.append(by * CW + bx)
    return out


def step_at(u, v, qbase, qsel):
    base = max(1, rdiv(qbase * QM[u][v], 16))
    return max(1, rdiv(base * QSEL_MULT[qsel], 16))


def idct(coef):
    """coef is a flat list of 64, row major (u*8+v)."""
    tmp = [0.0] * 64
    for y in range(8):
        for v in range(8):
            s = 0
            for u in range(8):
                s += C[u][y] * coef[u * 8 + v]
            tmp[y * 8 + v] = s
    out = [0.0] * 64
    for y in range(8):
        for x in range(8):
            s = 0
            for v in range(8):
                s += tmp[y * 8 + v] * C[v][x]
            out[y * 8 + x] = rdiv(int(s), 1 << INV_SHIFT)
    return out


def rdiv64(a):
    return (a + 32) // 64 if a >= 0 else -((-a + 32) // 64)


def slope_q6(d):
    return (d * 64 + 3) // 7 if d >= 0 else -((-d * 64 + 3) // 7)


def predict(mode, L, T, Cc, hasL, hasT):
    out = [0] * 64
    if mode == 0:
        return [128] * 64
    if mode == 1:
        vals = (L if hasL else []) + (T if hasT else [])
        return [rdiv(sum(vals), len(vals)) if vals else 128] * 64
    if mode == 2:
        if hasL:
            return [L[r] for r in range(8) for _ in range(8)]
        if hasT:
            return [T[c] for _ in range(8) for c in range(8)]
        return [128] * 64
    if mode == 3:
        if hasT:
            return [T[c] for _ in range(8) for c in range(8)]
        if hasL:
            return [L[r] for r in range(8) for _ in range(8)]
        return [128] * 64
    if mode == 4:
        if hasT:
            s = slope_q6((L[7] - L[0]) if hasL else (T[7] - T[0]))
            return [T[c] + rdiv64(s * r) for r in range(8) for c in range(8)]
        if hasL:
            return [L[r] for r in range(8) for _ in range(8)]
        return [128] * 64
    if mode == 5:
        if hasL:
            s = slope_q6((T[7] - T[0]) if hasT else (L[7] - L[0]))
            return [L[r] + rdiv64(s * c) for r in range(8) for c in range(8)]
        if hasT:
            return [T[c] for _ in range(8) for c in range(8)]
        return [128] * 64
    if mode == 6:
        if hasL and hasT:
            return [T[c] + L[r] - Cc for r in range(8) for c in range(8)]
        if hasT:
            return [T[c] for _ in range(8) for c in range(8)]
        if hasL:
            return [L[r] for r in range(8) for _ in range(8)]
        return [128] * 64
    raise ValueError("reserved mode %d" % mode)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    path, outpath = sys.argv[1], sys.argv[2]
    bit_len = None
    if "--bits" in sys.argv:
        bit_len = int(sys.argv[sys.argv.index("--bits") + 1])

    data = open(path, "rb").read()
    total = len(data) * 8
    limit = min(bit_len, total) if bit_len is not None else total
    b = Bits(data, limit)
    hdr = parse_header(b)
    W, H, qbase, lossless = hdr["W"], hdr["H"], hdr["qbase"], hdr["lossless"]
    CW, CH = (W + 7) // 8, (H + 7) // 8
    PW, PH = CW * 8, CH * 8
    N = CW * CH
    order = decode_order(CW, CH, hdr["order"])

    canvas = [0] * (PW * PH)
    done = [False] * N
    ok_count = 0
    last = -1
    failed = -1
    reason = ""
    consumed = HEADER_BITS

    for idx in order:
        bx, by = idx % CW, idx // CW
        hasL = by * CW + (bx - 1) >= 0 and bx > 0 and done[by * CW + bx - 1]
        hasT = by > 0 and done[(by - 1) * CW + bx]
        if hasL:
            L = [canvas[(by * 8 + i) * PW + bx * 8 - 1] for i in range(8)]
        else:
            L = [0] * 8
        if hasT:
            T = [canvas[(by * 8 - 1) * PW + bx * 8 + i] for i in range(8)]
        else:
            T = [0] * 8
        Cc = canvas[(by * 8 - 1) * PW + bx * 8 - 1] if (hasL and hasT) else 0
        try:
            if b.pos + 3 > limit:
                raise Truncated()
            if lossless:
                mode = b.read(3)
                if mode > 6:
                    raise ValueError("reserved mode")
                k = b.read(4)
                pred = predict(mode, L, T, Cc, hasL, hasT)
                for j in range(64):
                    u = b.rice(k)
                    v = (u + 1) // 2 if (u & 1) else -(u // 2)
                    px = pred[j] + v
                    canvas[(by * 8 + j // 8) * PW + bx * 8 + j % 8] = max(0, min(255, px))
            else:
                b.pos = b.pos  # noqa
                qsel = b.read(2)
                mode = b.read(3)
                if mode > 6:
                    raise ValueError("reserved mode")
                n = b.eg0() + 1
                if n > 64:
                    raise ValueError("numAC out of range")
                zz = [0] * 64
                zz[0] = b.eg0s()
                for z in range(1, n):
                    zz[z] = b.eg0s()
                coef = [0.0] * 64
                for z in range(n):
                    u, v = ZIGZAG[z]
                    coef[u * 8 + v] = zz[z] * step_at(u, v, qbase, qsel)
                pred = predict(mode, L, T, Cc, hasL, hasT)
                inv = idct(coef)
                for j in range(64):
                    v = inv[j] + pred[j]
                    canvas[(by * 8 + j // 8) * PW + bx * 8 + j % 8] = max(0, min(255, int(v)))
            done[idx] = True
            ok_count += 1
            last = idx
            consumed = b.pos
        except (Truncated, ValueError, IndexError) as e:
            failed = idx
            reason = "stream ended inside block" if isinstance(e, Truncated) else str(e)
            consumed = b.pos
            break

    img = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if done[(y // 8) * CW + (x // 8)]:
                img[y * W + x] = canvas[y * PW + x]
    with open(outpath, "wb") as f:
        f.write(("P5\n%d %d\n255\n" % (W, H)).encode("ascii"))
        f.write(bytes(img))

    print("decoded %d/%d blocks, last complete #%d" % (ok_count, N, last))
    if failed >= 0:
        print("INCOMPLETE at #%d: %s (consumed %d of %d bits)" % (failed, reason, consumed, total))
    else:
        print("ok, consumed %d of %d bits" % (consumed, total))


if __name__ == "__main__":
    main()
