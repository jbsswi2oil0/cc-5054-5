#!/usr/bin/env node
// Command line front end.
//
//   node tools/ivc.mjs sample <line|rings|texture> <out.pgm> [--size WxH]
//   node tools/ivc.mjs encode <in.pgm> <out.ivc> [options]
//   node tools/ivc.mjs decode <in.ivc> <out.pgm> [--bits N]
//   node tools/ivc.mjs info <in.ivc>
//   node tools/ivc.mjs compare <in.pgm> <in.ivc> [--against other.ivc]
//
// Options for encode:
//   --qbase N        base quantiser, default 16
//   --strategy S     local | chain, default local
//   --order O        raster | wavefront | column, default raster
//   --lambda X       chain weight, default 0.5
//   --lossless       reversible path (integer transform, no quantisation)
//
// decode --bits N truncates the stream to N bits, exactly as a cut transfer
// would, and reports the last block that could be fully determined.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parsePGM, writePGM } from "./pgm.mjs";
import { encode, decodeOrder } from "../src/encode.js";
import { decode, cropToImage } from "../src/decode.js";
import { readHeader, hexDump, HEADER_BITS } from "../src/format.js";
import { MODES } from "../src/predict.js";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(name); }
function ensure(path) { mkdirSync(dirname(path), { recursive: true }); }

function metrics(gray, W, H, crop) {
  let sse = 0, n = 0, maxe = 0;
  for (let i = 0; i < W * H; i++) {
    if (!crop.valid[i]) continue;
    const e = crop.pixels[i] - gray[i];
    sse += e * e; n++; maxe = Math.max(maxe, Math.abs(e));
  }
  const mse = n ? sse / n : 0;
  return { mse, psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse), maxErr: maxe, counted: n };
}

const cmd = process.argv[2];

if (cmd === "sample") {
  const which = process.argv[3];
  const out = process.argv[4];
  const size = arg("--size", "64x64").split("x").map(Number);
  const mod = await import("./samples.mjs");
  const make = mod.SAMPLES[which];
  if (!make) { console.error(`unknown sample ${which}; have ${Object.keys(mod.SAMPLES)}`); process.exit(2); }
  ensure(out);
  writeFileSync(out, writePGM(make.make(size[0], size[1]), size[0], size[1]));
  console.log(`wrote ${out} (${size[0]}x${size[1]}, ${make.name})`);
} else if (cmd === "encode") {
  const [inp, outp] = process.argv.slice(3, 5);
  const { W, H, data } = parsePGM(readFileSync(inp));
  const t0 = performance.now();
  const enc = encode(data, W, H, {
    qbase: Number(arg("--qbase", 16)),
    strategy: arg("--strategy", "local"),
    order: arg("--order", "raster"),
    lambda: Number(arg("--lambda", 0.5)),
    lossless: flag("--lossless"),
  });
  const dt = performance.now() - t0;
  ensure(outp);
  writeFileSync(outp, enc.bytes);
  console.log(`${W}x${H} blocks ${enc.trace.CW}x${enc.trace.CH}  ` +
    `${enc.bytes.length} B / ${enc.totalBits} b  ` +
    `(header ${enc.trace.headerBits} b, padding ${enc.trace.paddingBits} b)  ` +
    `${dt.toFixed(1)} ms  order=${enc.order} strategy=${enc.strategy} qbase=${enc.qbase}` +
    (enc.lossless ? " lossless" : ""));
  const modes = new Array(7).fill(0);
  for (const b of enc.trace.blocks) modes[b.mode]++;
  console.log("modes:", modes.map((n, i) => `${MODES[i]}=${n}`).join(" "));
} else if (cmd === "decode") {
  const [inp, outp] = process.argv.slice(3, 5);
  const bytes = new Uint8Array(readFileSync(inp));
  const bitLen = arg("--bits", null);
  const dec = decode(bytes, bitLen ? { bitLength: Number(bitLen) } : {});
  const crop = cropToImage(dec);
  if (outp) { ensure(outp); writeFileSync(outp, writePGM(crop.pixels, dec.W, dec.H)); }
  console.log(`decoded ${dec.completeBlocks}/${dec.CW * dec.CH} blocks, ` +
    `last complete #${dec.lastComplete}` +
    (dec.truncated ? `  INCOMPLETE at #${dec.failedAt}: ${dec.reason}` : "  ok"));
  console.log(`stream ${dec.bitLength} b, consumed ${dec.bitPos} b; ` +
    `undecoded pixels are written as 0 and are not displayed`);
  if (outp) console.log(`wrote ${outp}`);
} else if (cmd === "info") {
  const bytes = new Uint8Array(readFileSync(process.argv[3]));
  const h = readHeader(bytes);
  console.log(JSON.stringify({
    W: h.W, H: h.H, qbase: h.qbase, lossless: h.lossless,
    order: h.order, encoderHint: h.strategy,
    blocks: h.CW * h.CH, grid: `${h.CW}x${h.CH}`,
    bytes: bytes.length, headerBits: HEADER_BITS,
  }, null, 2));
  console.log("\nfirst 64 bytes:");
  console.log(hexDump(bytes, 0, 512));
} else if (cmd === "compare") {
  const [inp, ivc] = process.argv.slice(3, 5);
  const { W, H, data } = parsePGM(readFileSync(inp));
  const bytes = new Uint8Array(readFileSync(ivc));
  const dec = decode(bytes);
  const m = metrics(data, W, H, cropToImage(dec));
  const h = dec.header;
  console.log(`stream   ${bytes.length} B / ${bytes.length * 8} b  (${bytes.length * 8 / (W * H)} bpp)`);
  console.log(`decoded  ${dec.completeBlocks}/${dec.CW * dec.CH} blocks  qbase=${h.qbase} ` +
    `order=${h.order} ${h.lossless ? "lossless" : ""}`);
  console.log(`MSE      ${m.mse.toFixed(4)}   PSNR ${m.psnr === Infinity ? "inf" : m.psnr.toFixed(3)} dB   ` +
    `max|e| ${m.maxErr}`);
  const other = arg("--against", null);
  if (other) {
    const dec2 = decode(new Uint8Array(readFileSync(other)));
    const m2 = metrics(data, W, H, cropToImage(dec2));
    console.log(`against  ${other}: ${(readFileSync(other).length)} B, ` +
      `MSE ${m2.mse.toFixed(4)}, PSNR ${m2.psnr === Infinity ? "inf" : m2.psnr.toFixed(3)} dB`);
  }
} else {
  console.log(`usage:
  node tools/ivc.mjs sample <line|rings|texture> <out.pgm> [--size WxH]
  node tools/ivc.mjs encode <in.pgm> <out.ivc> [--qbase N] [--strategy local|chain] [--order raster|wavefront|column] [--lambda X] [--lossless]
  node tools/ivc.mjs decode <in.ivc> <out.pgm> [--bits N]
  node tools/ivc.mjs info <in.ivc>
  node tools/ivc.mjs compare <in.pgm> <in.ivc> [--against other.ivc]`);
  process.exit(cmd ? 2 : 0);
}
