// Inventory scanner: reads MapleStory item tooltips from a screen share (pixels only) with OCR.
// The parsing/image helpers are pure so they can be tested in Node; the capture part needs a browser.
(function(root){
'use strict';

const SLOT_WORDS = [
  [0, ['hat']],
  [1, ['top']],
  [2, ['pants', 'bottom']],
  [3, ['cape']],
  [4, ['glove', 'gloves']],
  [5, ['shoe', 'shoes']]
];
// Checked in order. Class names come before ATK because class lines read "[Hologram] Thief Attack Skill".
// Known wordings: "Dimensional Leap Lv. +1", "White Hole Lv. +1", "[Hologram] Registry Lv. +1",
// "[Hologram] Thief Attack Skill Lv. +1", "[Hologram] Magician Attack Skill Lv. +1",
// "[Hologram] Critical Damage Enhancement Skill Lv. +1", "[Hologram] Attack Power & Magic ATT Enhancement Skill Lv. +1".
const LINE_WORDS = [
  ['atk', ['attack power']],   // first: it also contains "Magic", which must not read as Mage
  ['dl', ['dimensional leap']],
  ['wh', ['white hole']],
  ['reg', ['registry']],
  ['pirate', ['pirate']],
  ['warrior', ['warrior']],
  ['mage', ['mage', 'magician']],
  ['thief', ['thief']],
  ['bowman', ['bowman', 'archer']],
  ['crit', ['critical', 'crit']],
  ['dmg', ['damage', 'dmg']],
  ['atk', ['attack', 'atk']]
];

function lev(a, b){
  if(a === b) return 0;
  const m = a.length, n = b.length; if(!m) return n; if(!n) return m;
  let prev = Array.from({length:n + 1}, (_, j) => j);
  for(let i = 1; i <= m; i++){
    const cur = [i];
    for(let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const tol = w => w.length >= 8 ? 2 : w.length >= 5 ? 1 : 0;
const tokens = s => s.toLowerCase().replace(/[0|]/g, m => m === '0' ? 'o' : 'l').split(/[^a-z]+/).filter(Boolean);
// True if a keyword (one or two words) appears in the token list, allowing a few OCR typos.
function hasWord(toks, kw){
  const w = kw.replace(/\s+/g, ''), parts = kw.split(/\s+/).length, t = tol(w);
  for(let i = 0; i + parts <= toks.length; i++){
    const cand = toks.slice(i, i + parts).join('');
    if(lev(cand, w) <= t) return true;
  }
  // OCR sometimes glues the two words together or splits one word in two.
  if(parts === 2) return toks.some(x => lev(x, w) <= t);
  return t > 0 && toks.some((x, i) => i + 1 < toks.length && lev(x + toks[i + 1], w) <= t - 1);
}

function lineKey(line){
  const toks = tokens(line);
  for(const [k, kws] of LINE_WORDS) if(kws.some(kw => hasWord(toks, kw))) return k;
  return 'other';
}

// "Lv. +1" / "Level +1" and common OCR misreads ("Ly.", "Lv, 4l").
const LV_RE = /\bl(?:\s*[vy]|evel)\b\s*[.,:;]?\s*[+4t]?\s*\d/i;
const isSkillLine = l => LV_RE.test(l) && !/requir/i.test(l);
// A long line wraps, leaving just "Skill Lv. +1" on the next line.
const isWrapTail = l => /^\W*sk[il1|]{2,3}\s*l(?:\s*[vy]|evel)\b/i.test(l);
function joinWrapped(lines){
  const out = [];
  for(const l of lines){
    if(isWrapTail(l) && out.length && !isSkillLine(out[out.length - 1])) out[out.length - 1] += ' ' + l;
    else out.push(l);
  }
  return out;
}

function findSlot(lines){
  for(let i = 0; i < Math.min(lines.length, 14); i++){
    const toks = tokens(lines[i]);
    for(const [slot, words] of SLOT_WORDS) for(const w of words){
      if(toks.includes(w) || (w.length >= 4 && toks.some(x => x.length >= 4 && lev(x, w) <= 1))) return {slot, line:lines[i]};
    }
  }
  return {slot:-1, line:''};
}

function parseTooltip(text){
  const lines = joinWrapped(String(text || '').split(/\r?\n/).map(l => l.replace(/[|]\s*$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  const {slot, line:titleLine} = findSlot(lines);
  // The 3 hologram lines sit right above "Scroll Enhancement" (or "Jewel Stats" if that line is missing).
  let skill = [];
  let a = lines.findIndex(l => /scr[o0]ll/i.test(l));
  if(a < 0) a = lines.findIndex(l => /jewel\s*stat/i.test(l));
  if(a > 0){ for(let i = a - 1; i >= 0 && skill.length < 3 && isSkillLine(lines[i]); i--) skill.unshift(lines[i]); }
  if(!skill.length) skill = lines.filter(isSkillLine).slice(-3);
  const keys = skill.map(lineKey);
  const cp = (text.match(/\+\s*(\d{1,3}(?:[,.]\d{3})+)/) || [])[1];
  const issues = [];
  if(slot < 0) issues.push('slot not found');
  if(keys.length < 3) issues.push(`only ${keys.length} line${keys.length === 1 ? '' : 's'} read`);
  if(keys.includes('other')) issues.push('unrecognised line');
  const real = keys.filter(k => k !== 'other');
  if(new Set(real).size !== real.length) issues.push('duplicate line');
  const sig = [slot, keys.join('+'), cp ? cp.replace(/\D/g, '') : tokens(titleLine).join('')].join('|');
  return {slot, lines:keys, raw:skill, title:titleLine, cp:cp || '', sig, issues};
}

// ---------- image helpers (operate on ImageData-like {width, height, data}) ----------
// Tooltip panel: dark, slightly blue-grey translucent background.
const isPanel = (r, g, b) => r >= 22 && r <= 80 && g >= 28 && g <= 86 && b >= 34 && b <= 96 && b >= r + 3 && Math.max(r, g, b) - Math.min(r, g, b) <= 34;

// Finds the tooltip region's bounding box: the largest connected group of mostly-panel 8x8 blocks.
function findRegion(img, opts = {}){
  const B = opts.block || 8, {width:W, height:H, data:d} = img;
  const bw = Math.floor(W / B), bh = Math.floor(H / B);
  const on = new Uint8Array(bw * bh);
  for(let by = 0; by < bh; by++) for(let bx = 0; bx < bw; bx++){
    let n = 0;
    for(let y = by * B; y < by * B + B; y += 2) for(let x = bx * B; x < bx * B + B; x += 2){
      const i = (y * W + x) * 4; if(isPanel(d[i], d[i + 1], d[i + 2])) n++;
    }
    on[by * bw + bx] = n >= (B * B / 4) * 0.45 ? 1 : 0;
  }
  const seen = new Uint8Array(bw * bh); let best = null;
  for(let s = 0; s < on.length; s++){
    if(!on[s] || seen[s]) continue;
    let x0 = bw, y0 = bh, x1 = -1, y1 = -1, count = 0; const stack = [s]; seen[s] = 1;
    while(stack.length){
      const c = stack.pop(), cx = c % bw, cy = (c - cx) / bw; count++;
      if(cx < x0) x0 = cx; if(cx > x1) x1 = cx; if(cy < y0) y0 = cy; if(cy > y1) y1 = cy;
      for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx = cx + dx, ny = cy + dy; if(nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const ni = ny * bw + nx; if(on[ni] && !seen[ni]){ seen[ni] = 1; stack.push(ni); }
      }
    }
    if(!best || count > best.count) best = {count, x0, y0, x1, y1};
  }
  if(!best) return null;
  const box = {x:Math.max(0, best.x0 * B - B), y:Math.max(0, best.y0 * B - B)};
  box.w = Math.min(W, (best.x1 + 2) * B + B) - box.x;
  box.h = Math.min(H, (best.y1 + 2) * B + B) - box.y;
  // A tooltip is tall and at least ~180px wide; anything smaller is some other dark UI.
  const minW = opts.minW || 180, minH = opts.minH || 220;
  if(box.w < minW || box.h < minH || best.count < 0.45 * (best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1)) return null;
  return box;
}

// Tooltip frame, from outside in: a 1px dark line, a 1px lighter line, then the panel. The frame is slightly
// translucent, so its colours shift with whatever is behind it (light inventory, grey floor, bright scenery).
// The test is therefore relative: the light line must be clearly brighter than both the dark line and the panel.
// i = dark-line pixel, j = the next pixel inward, k = 3px inward.
function edgeAt(d, i, j, k){
  const r = d[i], g = d[i + 1], b = d[i + 2];
  if(r > 80 || g > 80 || b > 85) return false;
  const lr = d[j], lg = d[j + 1], lb = d[j + 2], ls = lr + lg + lb;
  const kr = d[k], kg = d[k + 1], kb = d[k + 2], ks = kr + kg + kb;
  if(ls < r + g + b + 30 || ls < ks + 12 || lr > 175 || lg > 175 || lb > 180 || lb + 2 < lr) return false;
  const kmax = Math.max(kr, kg, kb);
  return kmax <= 105 && kmax - Math.min(kr, kg, kb) <= 40;
}
const overlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
// Vertical runs of edge pixels at least minLen tall, for left or right edges. Gaps up to GAP px are bridged
// (the mouse cursor or a bright pixel of scenery can interrupt the frame for a few rows).
function edgeRuns(img, side, minLen){
  const {width:W, height:H, data:d} = img, out = [];
  const dir = side === 'left' ? 1 : -1, GAP = 20;
  const x0 = side === 'left' ? 0 : 3, x1 = side === 'left' ? W - 3 : W;
  for(let x = x0; x < x1; x++){
    let start = -1, last = -GAP - 1;
    for(let y = 0; y <= H; y++){
      let hit = false;
      if(y < H){ const i = (y * W + x) * 4; hit = edgeAt(d, i, i + dir * 4, i + dir * 12); }
      if(hit){ if(y - last > GAP) start = y; last = y; }
      else if(start >= 0 && (y - last > GAP || y === H)){
        if(last - start >= minLen) out.push({x, y0:start, y1:last});
        start = -1;
      }
    }
  }
  // Neighbouring columns can both match; keep the tallest run per spot.
  const len = e => e.y1 - e.y0;
  return out.filter(e => !out.some(o => o !== e && Math.abs(o.x - e.x) <= 2 && overlap(o, e) > 0 && (len(o) > len(e) || (len(o) === len(e) && o.x < e.x))));
}
function panelFill(img, b){
  const {width:W, data:d} = img; let n = 0, t = 0;
  for(let y = b.y + 4; y < b.y + b.h - 4; y += 4) for(let x = b.x + 4; x < b.x + b.w - 4; x += 4){
    t++; const i = (y * W + x) * 4; if(isPanel(d[i], d[i + 1], d[i + 2])) n++;
  }
  return t ? n / t : 0;
}
// Pairs each left edge with the nearest thing that ends the panel on the right: its own right edge, or the left
// edge of a neighbouring tooltip (hovered and equipped tooltips touch, and must never merge into one box).
// diag (optional) collects every candidate and why it was kept or dropped, for the debug log.
function findPanelsByBorder(img, opts = {}, diag = null){
  const minW = opts.minW || 180, minH = opts.minH || 220;
  const lefts = edgeRuns(img, 'left', minH), rights = edgeRuns(img, 'right', minH);
  if(diag){ diag.lefts = lefts.map(e => [e.x, e.y0, e.y1]); diag.rights = rights.map(e => [e.x, e.y0, e.y1]); diag.candidates = []; }
  const fits = (L, E, minOv) => { const w = E.x - L.x; return w >= minW && w <= 900 && overlap(L, E) >= minOv * Math.min(L.y1 - L.y0, E.y1 - E.y0); };
  const panels = [];
  for(const L of lefts){
    const R = rights.filter(E => fits(L, E, 0.6)).sort((a, b) => a.x - b.x)[0];
    const N = lefts.filter(E => E !== L && fits(L, E, 0.3)).sort((a, b) => a.x - b.x)[0];
    const note = {left:[L.x, L.y0, L.y1]};
    let right, y0 = L.y0, y1 = L.y1;
    if(N && (!R || N.x <= R.x + 2)){ right = N.x - 2; note.endsAt = 'next-tooltip'; }
    else if(R){ right = R.x; y0 = Math.min(y0, R.y0); y1 = Math.max(y1, R.y1); note.endsAt = 'right-edge'; }
    else if(img.width - L.x >= minW && img.width - L.x <= 900 && borderIsPanel(img, img.width - 1, L)){ right = img.width - 1; note.endsAt = 'image-border'; }
    else{ note.drop = 'no right edge'; if(diag) diag.candidates.push(note); continue; }
    const box = {x:L.x, y:y0, w:right - L.x + 1, h:y1 - y0 + 1};
    note.box = box;
    const fill = panelFill(img, box); note.fill = +fill.toFixed(2);
    // Other windows (like the inventory) have a similar frame, but a tooltip is mostly dark panel inside.
    if(fill < 0.5) note.drop = 'not mostly panel inside';
    // Item tooltips are tall and narrow; wide dark boxes are other windows (e.g. a dark-theme browser).
    else if(box.h < 1.3 * box.w) note.drop = 'too wide for a tooltip';
    else if(panels.some(p => Math.abs(p.x - box.x) < 6 && Math.abs(p.y - box.y) < 12)) note.drop = 'duplicate';
    else panels.push(box);
    if(diag) diag.candidates.push(note);
  }
  // A cropped screenshot can cut off a tooltip's left edge: a right edge no panel claimed, with panel colour
  // running into the image's left border.
  for(const R of rights){
    if(panels.some(p => Math.abs(p.x + p.w - 1 - R.x) <= 3) || R.x < minW || R.x > 900 || !borderIsPanel(img, 0, R)) continue;
    const box = {x:0, y:R.y0, w:R.x + 1, h:R.y1 - R.y0 + 1}, fill = panelFill(img, box);
    const note = {right:[R.x, R.y0, R.y1], endsAt:'image-border', box, fill:+fill.toFixed(2)};
    if(fill < 0.5) note.drop = 'not mostly panel inside';
    else if(box.h < 1.3 * box.w) note.drop = 'too wide for a tooltip';
    else panels.push(box);
    if(diag) diag.candidates.push(note);
  }
  return panels.sort((a, b) => a.x - b.x);
}
// True if the image's border column x is mostly panel-coloured along the given edge run.
function borderIsPanel(img, x, run){
  const {width:W, data:d} = img; let n = 0, t = 0;
  for(let y = run.y0; y <= run.y1; y += 3){ t++; const i = (y * W + x) * 4; if(isPanel(d[i], d[i + 1], d[i + 2])) n++; }
  return t > 0 && n / t >= 0.6;
}

// Runs of indices whose panel fraction is at least `min`, as [start, end) pairs.
function runs(fracs, min){
  const out = []; let s = -1;
  fracs.forEach((f, i) => { if(f >= min){ if(s < 0) s = i; } else if(s >= 0){ out.push([s, i]); s = -1; } });
  if(s >= 0) out.push([s, fracs.length]);
  return out;
}
// Hovering an item shows its tooltip with the equipped item's tooltip beside it. Both panels form one dark
// region, split by a thin light border where almost no pixel is panel-coloured. Returns each panel, left to right.
function findPanels(img, opts = {}, diag = null){
  const framed = findPanelsByBorder(img, opts, diag);
  if(diag) diag.method = framed.length || !opts.fallback ? 'frame' : 'dark-region';
  // The dark-region fallback is only for pasted crops that may have cut off the frame; on a live screen it
  // mistakes other dark windows for tooltips.
  if(framed.length || !opts.fallback) return framed;
  const region = findRegion(img, opts); if(!region) return [];
  const {width:W, data:d} = img, minW = opts.minW || 180, minH = opts.minH || 220;
  const at = (x, y) => { const i = (y * W + x) * 4; return isPanel(d[i], d[i + 1], d[i + 2]); };
  const colF = [];
  for(let x = region.x; x < region.x + region.w; x++){
    let n = 0, t = 0; for(let y = region.y; y < region.y + region.h; y += 2){ t++; if(at(x, y)) n++; }
    colF.push(n / t);
  }
  const panels = [];
  for(const [c0, c1] of runs(colF, 0.25)){
    if(c1 - c0 < minW) continue;
    const x = region.x + c0, w = c1 - c0;
    // The two panels can differ in height, so trim each one to its own rows.
    const rowF = [];
    for(let y = region.y; y < region.y + region.h; y++){
      let n = 0, t = 0; for(let xx = x; xx < x + w; xx += 2){ t++; if(at(xx, y)) n++; }
      rowF.push(n / t);
    }
    const rr = runs(rowF, 0.25).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
    if(!rr || rr[1] - rr[0] < minH) continue;
    const pad = 3;
    const bx = Math.max(0, x - pad), by = Math.max(0, region.y + rr[0] - pad);
    panels.push({x:bx, y:by, w:Math.min(W, x + w + pad) - bx, h:Math.min(img.height, region.y + rr[1] + pad) - by});
  }
  return panels.length ? panels : [region];
}
const findPanel = (img, opts) => findPanels(img, opts)[0] || null;
const isEquippedText = t => /curr?ent[il1]y\s*equ[il1]pp?ed/i.test(t);

// Light text on a dark panel -> dark text on white, contrast-stretched, for OCR. Modifies img in place.
function preprocess(img){
  const d = img.data;
  for(let i = 0; i < d.length; i += 4){
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    const o = 255 - Math.max(0, Math.min(255, (v - 75) * 2.2));
    d[i] = d[i + 1] = d[i + 2] = o; d[i + 3] = 255;
  }
  return img;
}

// Fingerprint of a tooltip: average brightness of fixed 8x8px cells, anchored at the box's top-left corner
// (which the frame detection finds to the pixel) and covering the top 560px. The bottom edge is ignored because
// its detected position wobbles with the scenery behind it.
const CELL = 8, FP_HEIGHT = 560;
function thumb(img, box){
  const {width:W, height:H, data:d} = img;
  const cols = Math.max(1, Math.floor((box.w - 4) / CELL)), rows = Math.max(1, Math.floor((Math.min(box.h, FP_HEIGHT) - 4) / CELL));
  const out = new Float32Array(cols * rows);
  for(let cy = 0; cy < rows; cy++) for(let cx = 0; cx < cols; cx++){
    const x0 = box.x + 2 + cx * CELL, y0 = box.y + 2 + cy * CELL; let s = 0, n = 0;
    for(let y = y0; y < y0 + CELL && y < H; y++) for(let x = x0; x < x0 + CELL && x < W; x++){ const i = (y * W + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; n++; }
    out[cy * cols + cx] = n ? s / n / 3 : 0;
  }
  out.cols = cols; out.rows = rows;
  return out;
}
// Share of cells whose brightness changed noticeably (0 = identical, 1 = completely different).
function thumbDiff(a, b){
  if(!a || !b || a.cols !== b.cols) return 1;
  const rows = Math.min(a.rows, b.rows), cols = a.cols; let n = 0;
  for(let i = 0; i < rows * cols; i++) if(Math.abs(a[i] - b[i]) > 10) n++;
  return n / (rows * cols);
}

// ---------- browser capture ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerP = null, debugLog = null;
// The page can install a logger that receives every scanner event: Scanner.setLogger((type, data) => ...).
const log = (type, data) => { if(debugLog) try{ debugLog(type, data || {}); }catch(e){} };
function loadScript(src){
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load OCR library')); document.head.appendChild(s); });
}
function getWorker(onStatus){
  if(!workerP) workerP = (async () => {
    const t0 = performance.now();
    onStatus && onStatus('Loading OCR engine… (first time only)');
    log('ocr-engine', {state:'loading', url:TESSERACT_URL});
    if(!root.Tesseract) await loadScript(TESSERACT_URL);
    let lastStatus = '';
    const w = await root.Tesseract.createWorker('eng', 1, {logger:m => {
      // Tesseract reports progress many times per job; log each status change and each completion.
      if(m.status !== lastStatus || m.progress === 1){ lastStatus = m.status; log('tesseract', {status:m.status, progress:+(m.progress || 0).toFixed(2), job:m.jobId}); }
    }});
    await w.setParameters({tessedit_pageseg_mode:'6', preserve_interword_spaces:'1'});
    log('ocr-engine', {state:'ready', ms:Math.round(performance.now() - t0)});
    return w;
  })().catch(e => { workerP = null; log('ocr-engine', {state:'error', message:e.message}); throw e; });
  return workerP;
}

// Crops the box out of a source canvas, upscales 2x, preprocesses, and OCRs it.
async function ocrBox(srcCanvas, box, onStatus){
  const c = document.createElement('canvas'); c.width = box.w * 2; c.height = box.h * 2;
  const g = c.getContext('2d', {willReadFrequently:true}); g.imageSmoothingEnabled = true;
  g.drawImage(srcCanvas, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height); preprocess(img); g.putImageData(img, 0, 0);
  const w = await getWorker(onStatus);
  const t0 = performance.now();
  const {data} = await w.recognize(c);
  return {text:data.text, confidence:Math.round(data.confidence), ms:Math.round(performance.now() - t0), canvas:c, box};
}

// Picks the panel that is the item being looked at. Usually that's the left one (hovered item, with the equipped
// item beside it). But the game can flip the pair near the screen edge, and hovering an equipped item shows the
// set-effect list beside it instead. So: if the left panel isn't clearly a hovered item with 3 lines, also read
// the other panels and keep the one that looks most like an item (not "Currently Equipped", most lines read).
const panelScore = (p, equipped) => (equipped ? 0 : 4) + p.lines.length * 2 + (p.slot >= 0 ? 1 : 0);
async function ocrHovered(srcCanvas, panels, onStatus){
  const tries = [];
  for(let i = 0; i < Math.min(panels.length, 3); i++){
    const r = await ocrBox(srcCanvas, panels[i], onStatus);
    const p = parseTooltip(r.text), equipped = isEquippedText(r.text);
    Object.assign(r, {panel:i, score:panelScore(p, equipped)});
    log('ocr-pass', {panel:i, box:panels[i], ms:r.ms, confidence:r.confidence, equipped, score:r.score, slot:p.slot, lines:p.lines, text:r.text});
    tries.push(r);
    if(i === 0 && !equipped && p.slot >= 0 && p.lines.length === 3) break;
  }
  const best = tries.reduce((a, c) => c.score > a.score ? c : a);
  if(tries.length > 1) log('ocr-choice', {chosen:best.panel, scores:tries.map(t => t.score)});
  return best;
}

// Reads one still image (pasted/dropped screenshot).
async function scanImage(source, onStatus){
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', {willReadFrequently:true}); g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const diag = {}, t0 = performance.now();
  const panels = findPanels(img, {minW:120, minH:150, fallback:true}, diag);
  log('paste-detect', {width:c.width, height:c.height, ms:Math.round(performance.now() - t0), panels, diag});
  onStatus && onStatus('Reading screenshot…');
  const r = await ocrHovered(c, panels.length ? panels : [{x:0, y:0, w:c.width, h:c.height}], onStatus);
  const p = parseTooltip(r.text);
  log('parse', {source:'paste', panel:r.panel, confidence:r.confidence, slot:p.slot, lines:p.lines, raw:p.raw, title:p.title, cp:p.cp, sig:p.sig, issues:p.issues});
  return {...p, text:r.text, preview:r.canvas, source:c, panels};
}

// Live scanner over a screen share. Calls onItem(parsed) each time a settled tooltip is read, and
// onFrame(info) for every analysed frame so the page can show what the scanner sees.
// Frames are pulled straight from the capture track (MediaStreamTrackProcessor) when the browser supports it,
// which keeps working while the game window covers Chrome; timers and hidden <video> elements get throttled then.
// Same tooltip position: compare the top-left corner and width (the bottom edge wobbles with the scenery).
const sameBox = (a, b, t = 3) => !!a && !!b && Math.abs(a.x - b.x) <= t && Math.abs(a.y - b.y) <= t && Math.abs(a.w - b.w) <= t;
const boxDelta = (a, b) => a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : null;
const SETTLE_CHANGE = 0.02, SAME_ITEM_CHANGE = 0.04;
function createLiveScanner({onStatus, onItem, onPreview, onFrame, onSnapshot, onStop, interval = 400}){
  let stream = null, running = false, busy = false, reader = null, video = null, timer = null;
  let prev = null, lastOcr = null, lastAt = 0, frames = 0, fpsAt = 0, fps = 0, frameNo = 0, lastDecision = '';
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d', {willReadFrequently:true});
  const status = m => onStatus && onStatus(m);

  // Analyse whatever is currently drawn on the canvas, and decide what to do with it.
  function analyse(){
    const W = canvas.width, H = canvas.height, n = ++frameNo;
    const img = g.getImageData(0, 0, W, H);
    const diag = {}, t0 = performance.now();
    const panels = findPanels(img, {}, diag), box = panels[0];
    const detectMs = Math.round(performance.now() - t0);
    frames++; const now = performance.now();
    if(now - fpsAt >= 1000){ fps = frames * 1000 / (now - fpsAt || 1); frames = 0; fpsAt = now; }
    onFrame && onFrame({canvas, width:W, height:H, panels, fps});
    const entry = {n, width:W, height:H, detectMs, method:diag.method, lefts:diag.lefts, rights:diag.rights, candidates:diag.candidates, panels};
    let decision, t = null;
    if(!box){ decision = 'no-tooltip'; prev = null; status('Watching… no tooltip on screen. Hover over an item.'); }
    else{
      t = thumb(img, box);
      entry.vsPrev = prev ? {boxDelta:boxDelta(box, prev.box), change:+thumbDiff(t, prev.t).toFixed(3)} : null;
      entry.vsLastRead = lastOcr ? {frame:lastOcr.n, boxDelta:boxDelta(box, lastOcr.box), change:+thumbDiff(t, lastOcr.t).toFixed(3)} : null;
      // Read once the tooltip holds still (same box and look as the previous frame) and isn't the one just read.
      const settled = !!prev && sameBox(box, prev.box) && thumbDiff(t, prev.t) < SETTLE_CHANGE;
      const alreadyRead = !!lastOcr && sameBox(box, lastOcr.box, 6) && thumbDiff(t, lastOcr.t) < SAME_ITEM_CHANGE;
      prev = {box, t};
      if(busy) decision = 'busy-reading';
      else if(!settled) decision = 'waiting-to-settle';
      else if(alreadyRead){ decision = 'already-read'; status('Tooltip already read. Hover over the next item.'); }
      else decision = 'read';
    }
    entry.decision = decision;
    log('frame', entry);
    // Save a picture whenever what the scanner is doing changes (OCR attempts save their own, below).
    if(decision !== lastDecision && decision !== 'read' && onSnapshot) onSnapshot('frame-' + decision, canvas);
    lastDecision = decision;
    if(decision !== 'read') return;

    busy = true; lastOcr = {box, t, n};
    // OCR a snapshot so new frames can keep coming in meanwhile.
    const snap = document.createElement('canvas'); snap.width = W; snap.height = H; snap.getContext('2d').drawImage(canvas, 0, 0);
    status('Reading tooltip…');
    log('ocr-start', {frame:n, panels});
    const t1 = performance.now();
    ocrHovered(snap, panels, onStatus).then(r => {
      const p = {...parseTooltip(r.text), text:r.text};
      log('parse', {source:'live', frame:n, panel:r.panel, totalMs:Math.round(performance.now() - t1), confidence:r.confidence, slot:p.slot, lines:p.lines, raw:p.raw, title:p.title, cp:p.cp, sig:p.sig, issues:p.issues});
      onPreview && onPreview(r.canvas);
      if(onSnapshot){ onSnapshot('ocr-' + n + '-full', snap); onSnapshot('ocr-' + n + '-crop', r.canvas); }
      if(p.lines.length || p.slot >= 0) onItem(p);
      else{ status('Found a tooltip but could not read hologram lines from it.'); log('item', {action:'unreadable', frame:n}); }
    }).catch(e => { status('OCR error: ' + e.message); log('error', {where:'ocr', message:e.message, stack:e.stack}); })
      .finally(() => { busy = false; });
  }

  async function pump(track){
    reader = new root.MediaStreamTrackProcessor({track}).readable.getReader();
    let received = 0, skipped = 0, lastReport = performance.now();
    while(running){
      const {value:frame, done} = await reader.read().catch(e => { log('error', {where:'frame-reader', message:e.message}); return {done:true}; });
      if(done){ log('capture', {state:'stream-ended'}); break; }
      received++;
      const now = performance.now();
      if(now - lastReport > 5000){ log('capture-stats', {framesReceived:received, framesSkipped:skipped, busy}); received = skipped = 0; lastReport = now; }
      if(busy || now - lastAt < interval){ frame.close(); skipped++; continue; }
      lastAt = now;
      const W = frame.displayWidth, H = frame.displayHeight;
      if(canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; log('capture', {state:'frame-size', width:W, height:H}); }
      g.drawImage(frame, 0, 0, W, H); frame.close();
      try{ analyse(); }catch(e){ status('Scan error: ' + e.message); log('error', {where:'analyse', message:e.message, stack:e.stack}); }
    }
  }
  function tickVideo(){
    if(!video || video.readyState < 2 || busy) return;
    const W = video.videoWidth, H = video.videoHeight; if(!W || !H) return;
    if(canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; log('capture', {state:'frame-size', width:W, height:H}); }
    g.drawImage(video, 0, 0);
    try{ analyse(); }catch(e){ status('Scan error: ' + e.message); log('error', {where:'analyse', message:e.message, stack:e.stack}); }
  }

  return {
    async start(){
      log('capture', {state:'requesting'});
      stream = await navigator.mediaDevices.getDisplayMedia({
        video:{displaySurface:'monitor', cursor:'never', width:{ideal:7680}, height:{ideal:4320}, frameRate:{ideal:5, max:10}},
        audio:false, selfBrowserSurface:'exclude', surfaceSwitching:'include', monitorTypeSurfaces:'include'
      });
      const track = stream.getVideoTracks()[0];
      log('capture', {state:'started', label:track.label, settings:track.getSettings ? track.getSettings() : null, frameSource:root.MediaStreamTrackProcessor ? 'track-processor' : 'video-element'});
      track.addEventListener('ended', () => { log('capture', {state:'track-ended (sharing stopped)'}); this.stop(); });
      track.addEventListener('mute', () => log('capture', {state:'track-muted'}));
      track.addEventListener('unmute', () => log('capture', {state:'track-unmuted'}));
      running = true; frameNo = 0; lastDecision = '';
      getWorker(onStatus).then(() => status('Watching… hover over an item to show its tooltip.'), e => status(e.message));
      if(root.MediaStreamTrackProcessor) pump(track);
      else{
        video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
        await video.play(); timer = setInterval(tickVideo, interval);
      }
    },
    stop(){
      if(!running) return;
      running = false; clearInterval(timer); timer = null;
      if(reader) reader.cancel().catch(() => {});
      if(stream) stream.getTracks().forEach(t => t.stop());
      stream = null; video = null; reader = null; prev = lastOcr = null;
      log('capture', {state:'stopped', frames:frameNo});
      onStop && onStop();
    },
    get running(){ return running; }
  };
}

const setLogger = fn => { debugLog = fn; };
const api = {parseTooltip, lineKey, findPanel, findPanels, isEquippedText, preprocess, thumb, thumbDiff, sameBox, lev, scanImage, createLiveScanner, setLogger};
if(typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Scanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
