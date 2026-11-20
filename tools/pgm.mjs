// Minimal binary PGM (P5) reader/writer, 8-bit only.

export function parsePGM(buf) {
  // header: P5 <w> <h> <maxval> <single whitespace> then raw bytes
  let i = 0;
  const skipWS = () => { while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++; };
  const token = () => {
    skipWS();
    if (buf[i] === 35) { // comment
      while (i < buf.length && buf[i] !== 10) i++;
      return token();
    }
    const start = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++;
    return String.fromCharCode(...buf.slice(start, i));
  };
  const magic = token();
  if (magic !== "P5") throw new Error(`not a P5 PGM (got ${magic})`);
  const W = parseInt(token(), 10), H = parseInt(token(), 10), maxv = parseInt(token(), 10);
  if (maxv !== 255) throw new Error(`only 8-bit PGM supported (maxval ${maxv})`);
  skipWS(); // exactly one whitespace after maxval
  const data = buf.slice(i, i + W * H);
  if (data.length !== W * H) throw new Error("PGM payload truncated");
  return { W, H, data: Uint8Array.from(data) };
}

export function writePGM(gray, W, H) {
  const header = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(header.length + W * H);
  out.set(header, 0);
  out.set(gray, header.length);
  return out;
}
