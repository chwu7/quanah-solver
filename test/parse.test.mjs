import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../scanner.js');

// Real Tesseract output for test/fixtures/shoes-warrior.png (trimmed), noise included.
const SHOES = `|     Libae's Supercharged Shoes (Warrior)     l
|                      Heroic: Untradahle
    pod              +158,187 |
|     J                               Armor   |
|                                            Shoes
  Required Job Warrior
Required Level Ly. 160
Attack Power +12
Jump #11 (TF +1 +3)

White Hole Lv. +1
|  [Hologram] Thief Attack Skill Lv. +1

Dimensional Leap Lv. +1

Scroll Enhancement Mone
Jewel Stats`;

test('parses the sample shoes tooltip', () => {
  const p = S.parseTooltip(SHOES);
  assert.equal(p.slot, 5);
  assert.deepEqual(p.lines, ['wh', 'thief', 'dl']);
  assert.equal(p.cp, '158,187');
  assert.deepEqual(p.issues, []);
});

test('class lines beat ATK, and Damage is not read as Mage', () => {
  assert.equal(S.lineKey('[Hologram] Warrior Attack Skill Lv. +1'), 'warrior');
  assert.equal(S.lineKey('[Hologram] Mage Attack Skill Lv. +1'), 'mage');
  assert.equal(S.lineKey('Damage Lv. +1'), 'dmg');
  assert.equal(S.lineKey('Critical Damage Lv. +1'), 'crit');
  assert.equal(S.lineKey('Attack Lv. +1'), 'atk');
  assert.equal(S.lineKey('Registry Lv. +1'), 'reg');
  assert.equal(S.lineKey('Something Else Lv. +1'), 'other');
});

test('tolerates OCR typos', () => {
  assert.equal(S.lineKey('Dimensiona1 Lcap Lv. +1'), 'dl');
  assert.equal(S.lineKey('Whitc Hole Lv. +1'), 'wh');
  assert.equal(S.lineKey('[Hologram] Thlef Attack Skill Lv. +1'), 'thief');
});

test('Pants maps to Bottom; other slot names', () => {
  const t = s => S.parseTooltip(`Cool ${s} (Thief)\nWhite Hole Lv. +1\nScroll Enhancement None`).slot;
  assert.equal(t('Pants'), 2);
  assert.equal(t('Hat'), 0);
  assert.equal(t('Top'), 1);
  assert.equal(t('Cape'), 3);
  assert.equal(t('Gloves'), 4);
  assert.equal(t('Shoes'), 5);
});

test('falls back to every Lv. +N line when the anchor is missing', () => {
  const p = S.parseTooltip('Nice Cape (Mage)\nRequired Level Lv. 160\nRegistry Lv. +1\nAttack Lv. +1\nDamage Lv. +1');
  assert.equal(p.slot, 3);
  assert.deepEqual(p.lines, ['reg', 'atk', 'dmg']);
});

test('flags incomplete reads', () => {
  const p = S.parseTooltip('Some Glove (Bowman)\nWhite Hole Lv. +1\nScroll Enhancement None');
  assert.deepEqual(p.lines, ['wh']);
  assert.ok(p.issues.some(i => i.includes('only 1')));
});

// ---- image: find the tooltip inside a bigger, busy frame ----
function decodePng(path){
  const b = fs.readFileSync(path); let o = 8, W, H, ct; const idat = [];
  while(o < b.length){ const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if(type === 'IHDR'){ W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    if(type === 'IDAT') idat.push(d); o += 12 + len; }
  const bpp = {2:3, 6:4}[ct], raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(W * H * 4), stride = W * bpp;
  let prev = Buffer.alloc(stride);
  for(let y = 0; y < H; y++){
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for(let x = 0; x < stride; x++){ const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = line[x];
      if(f === 1) v += a; else if(f === 2) v += up; else if(f === 3) v += (a + up) >> 1;
      else if(f === 4){ const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? up : c; }
      line[x] = v & 255; }
    for(let x = 0; x < W; x++){ const s = x * bpp, d = (y * W + x) * 4; out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
    prev = line;
  }
  return {width:W, height:H, data:out};
}

test('findPanel locates the tooltip in a larger frame', () => {
  const tip = decodePng(new URL('./fixtures/shoes-warrior.png', import.meta.url));
  const W = 1280, H = 900, data = Buffer.alloc(W * H * 4);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for(let i = 0; i < data.length; i += 4){ data[i] = 90 + rnd() * 160; data[i + 1] = 80 + rnd() * 170; data[i + 2] = 40 + rnd() * 120; data[i + 3] = 255; }
  const ox = 600, oy = 120;
  for(let y = 0; y < tip.height; y++) tip.data.copy(data, ((oy + y) * W + ox) * 4, y * tip.width * 4, (y + 1) * tip.width * 4);
  const box = S.findPanel({width:W, height:H, data});
  assert.ok(box, 'panel found');
  assert.ok(box.x <= ox && box.y <= oy, `box starts before tooltip: ${JSON.stringify(box)}`);
  assert.ok(box.x + box.w >= ox + tip.width - 8 && box.y + box.h >= oy + tip.height - 8, `box covers tooltip: ${JSON.stringify(box)}`);
  assert.ok(box.w < tip.width + 40 && box.h < tip.height + 40, `box is tight: ${JSON.stringify(box)}`);
});
