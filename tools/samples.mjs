// Deterministic sample images used by the tests, the UI and the docs.
// Everything here is pure arithmetic so the bytes are reproducible.

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// A smooth background with a contrast step exactly on a block boundary at
// x = 32, and one thin diagonal line crossing the boundary between the two
// blocks at (16..24, 8..16) and (24..32, 8..16).  The line is one pixel wide
// and has a large amplitude, which is the hard case for direction prediction:
// the line continues into the neighbour block, so a direction chosen only for
// the local error may misalign the edge the neighbour needs.
export function sampleLine(W = 64, H = 64) {
  const g = new Uint8Array(W * H);
  const stepX = 32;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // background: gentle 2D ramp on one side, 40% darker on the other
      let v = 96 + 0.55 * x + 0.35 * y;
      if (x >= stepX) v *= 0.62;
      // thin bright diagonal, slope 2/3, through the middle
      const ly = 0.6667 * (x - 8) + 18;
      if (Math.abs(y - ly) <= 0.55) v += 118;
      // a second, fainter diagonal with the opposite slope
      const ly2 = -0.5 * (x - W) + 12;
      if (Math.abs(y - ly2) <= 0.5) v += 46;
      g[y * W + x] = clamp255(Math.round(v));
    }
  }
  return g;
}

// Concentric rings plus a hard square: gives strong direction cues and a
// large flat area where quantisation choice matters.
export function sampleRings(W = 64, H = 64) {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - 26, dy = y - 36;
      const r = Math.sqrt(dx * dx + dy * dy);
      let v = 128 + 55 * Math.sin(r * 0.45);
      if (x >= 40 && x < 56 && y >= 12 && y < 28) v = 226;
      g[y * W + x] = clamp255(Math.round(v));
    }
  }
  return g;
}

// Random-looking but deterministic texture with a low-frequency component.
export function sampleTexture(W = 64, H = 64, seed = 12345) {
  const g = new Uint8Array(W * H);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const low = 128 + 40 * Math.sin(x * 0.09) + 30 * Math.cos(y * 0.13);
      g[y * W + x] = clamp255(Math.round(low + (rnd() - 0.5) * 24));
    }
  }
  return g;
}

export const SAMPLES = {
  line: { name: "thin line / block-edge contrast", make: sampleLine },
  rings: { name: "rings / hard square", make: sampleRings },
  texture: { name: "low-frequency texture", make: sampleTexture },
};

// Pack a grayscale plane as an 8-bit PGM file (P5), so external tools can
// compare against the reference decoders.
export function toPGM(gray, W, H) {
  const header = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(header.length + W * H);
  out.set(header, 0);
  out.set(gray, header.length);
  return out;
}
