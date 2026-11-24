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

// Real Tesseract hologram blocks from the other fixtures (note "Ly." misreads, "Level", and a wrapped line).
const BLOCKS = {
  'shoes-crit-thief-dl': [5, `Libae's Supercharged Shoes (Warrior)     |
Jump +16 (7 +3 +6)
Dimensional Leap Lv. +1
[Hologram] Critical Damage Enhancement Skill Ly. +1
[Hologram] Thief Attack Skill Lv. +1
Scroll Enhancement Mone`, ['dl', 'crit', 'thief']],
  'top-pirate-mage-warrior': [1, `Libae's Supercharged Top (Warrior)
Enemy DEF Ignored +5%
[Hologram] Pirate Attack Skill Lv. +1
[Hologram] Magician Attack Skill Ly. +1                   |
[Hologram] Warrior Attack Skill Level Lv. +1               |
Scroll Enhancement Mone                        |`, ['pirate', 'mage', 'warrior']],
  'pants-crit-reg-atk': [2, `Libae's Supercharged Pants (Warrior)
Required Level Lv. 135 (160 - 25)
[Hologram] Critical Damage Enhancement Skill Ly. +1
[Hologram] Registry Ly. +1
[Hologram] Attack Power & Magic ATT Enhancement
Skill Ly. +1
Scroll Enhancement Mone`, ['crit', 'reg', 'atk']],
  'top-thief-dl-crit': [1, `Libae's Supercharged Top (Warrior)
[Hologram] Thief Attack Skill Lv. +1
Dimensional Leap Lv. +1
[Hologram] Critical Damage Enhancement Skill Ly. +1
Scroll Enhancement Mone`, ['thief', 'dl', 'crit']]
};
for(const [name, [slot, text, lines]] of Object.entries(BLOCKS)){
  test(`parses ${name}`, () => {
    const p = S.parseTooltip(text);
    assert.equal(p.slot, slot);
    assert.deepEqual(p.lines, lines);
    assert.deepEqual(p.issues, []);
  });
}

test('"Warrior Attack Skill Level +1" without Lv.', () => {
  assert.deepEqual(S.parseTooltip('Hat (Thief)\nWhite Hole Lv. +1\nRegistry Lv. +1\n[Hologram] Warrior Attack Skill Level +1\nScroll Enhancement None').lines, ['wh', 'reg', 'warrior']);
});

test('class lines beat ATK, and Damage is not read as Mage', () => {
  assert.equal(S.lineKey('[Hologram] Attack Power & Magic ATT Enhancement Skill Lv. +1'), 'atk');
  assert.equal(S.lineKey('[Hologram] Damage Enhancement Skill Lv. +1'), 'dmg');
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
  // The fixture's frame sits at x 1..323, y 11..632 inside the image.
  assert.ok(box.x <= ox + 6 && box.y <= oy + 14, `box starts at the frame: ${JSON.stringify(box)}`);
  assert.ok(box.x + box.w >= ox + 318 && box.y + box.h >= oy + 625, `box covers the frame: ${JSON.stringify(box)}`);
  assert.ok(box.w < tip.width + 40 && box.h < tip.height + 40, `box is tight: ${JSON.stringify(box)}`);
});

test('findPanels splits hovered + equipped tooltips and keeps the left one first', () => {
  const im = decodePng(new URL('./fixtures/compare-pants.png', import.meta.url));
  const panels = S.findPanels(im, {minW:120, minH:150});
  assert.equal(panels.length, 2);
  assert.ok(panels[0].x < 20 && panels[0].x + panels[0].w <= 340, JSON.stringify(panels[0]));
  assert.ok(panels[1].x >= 315 && panels[1].x + panels[1].w >= 640, JSON.stringify(panels[1]));
  assert.deepEqual(S.findPanel(im, {minW:120, minH:150}), panels[0]);
});

test('detects the equipped tooltip text', () => {
  assert.ok(S.isEquippedText('Combat Power Increase\nCurrently Equipped\nArmor'));
  assert.ok(S.isEquippedText('Currentiy Equlpped'));
  assert.ok(!S.isEquippedText('+ 17,548\nArmor'));
});

test('finds hovered + equipped tooltips on a full game screenshot (touching the inventory and scenery)', () => {
  const im = decodePng(new URL('./fixtures/fullscreen-hat.png', import.meta.url));
  for(const opts of [{}, {minW:120, minH:150}]){
    const panels = S.findPanels(im, opts);
    assert.equal(panels.length, 2, JSON.stringify(panels));
    const [a, b] = panels;
    assert.ok(Math.abs(a.x - 1269) <= 4 && Math.abs(a.x + a.w - 1592) <= 4, JSON.stringify(a));
    assert.ok(a.y <= 480 && a.y + a.h >= 1085, JSON.stringify(a));
    assert.ok(Math.abs(b.x - 1593) <= 4, JSON.stringify(b));
  }
});

// Real frames from a live capture (cropped to the game area on the right).
test('live frame: tooltip bottom over grey floor still gets its full height', () => {
  const im = decodePng(new URL('./fixtures/live-top-over-floor.png', import.meta.url));
  const panels = S.findPanels(im);
  assert.equal(panels.length, 2, JSON.stringify(panels));
  const [a, b] = panels;
  assert.ok(a.w >= 318 && a.w <= 328, JSON.stringify(a));
  assert.ok(a.y <= 440 && a.y + a.h >= 1015, `hovered tooltip reaches the bottom lines: ${JSON.stringify(a)}`);
  assert.ok(b.x >= a.x + a.w - 4, 'panels do not overlap');
});

test('live frame: equipped item with its set-effect list beside it', () => {
  const im = decodePng(new URL('./fixtures/live-equipped-hat-set.png', import.meta.url));
  const panels = S.findPanels(im);
  assert.equal(panels.length, 2, JSON.stringify(panels));
  assert.ok(panels[0].w >= 318 && panels[0].w <= 328 && panels[0].h >= 600, JSON.stringify(panels[0]));
});

test('fingerprint: repeated frames are "same"; a different item at the same spot is "changed"', () => {
  const one = decodePng(new URL('./fixtures/live-top-over-floor.png', import.meta.url));
  const two = decodePng(new URL('./fixtures/live-top-same-spot.png', import.meta.url));   // another Top, same position
  const [a] = S.findPanels(one), [b] = S.findPanels(two);
  assert.ok(S.sameBox(a, b), 'same tooltip position: ' + JSON.stringify([a, b]));
  assert.equal(S.thumbDiff(S.thumb(one, a), S.thumb(one, a)), 0);
  assert.ok(S.thumbDiff(S.thumb(one, a), S.thumb(two, b)) > 0.1, 'different item must register as a change');
});
