// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for Node tests and tools. No dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decodePng(path){
  const b = fs.readFileSync(path); let o = 8, W, H, ct; const idat = [];
  while(o < b.length){
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if(type === 'IHDR'){ W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; if(d[8] !== 8 || d[12]) throw new Error('unsupported PNG'); }
    if(type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = {2:3, 6:4}[ct]; if(!bpp) throw new Error('unsupported PNG colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(W * H * 4), stride = W * bpp;
  let prev = Buffer.alloc(stride);
  for(let y = 0; y < H; y++){
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for(let x = 0; x < stride; x++){
      const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = line[x];
      if(f === 1) v += a; else if(f === 2) v += up; else if(f === 3) v += (a + up) >> 1;
      else if(f === 4){ const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? up : c; }
      line[x] = v & 255;
    }
    for(let x = 0; x < W; x++){ const s = x * bpp, d = (y * W + x) * 4; out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
    prev = line;
  }
  return {width:W, height:H, data:out};
}
