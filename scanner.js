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

// Runs of indices whose panel fraction is at least `min`, as [start, end) pairs.
function runs(fracs, min){
  const out = []; let s = -1;
  fracs.forEach((f, i) => { if(f >= min){ if(s < 0) s = i; } else if(s >= 0){ out.push([s, i]); s = -1; } });
  if(s >= 0) out.push([s, fracs.length]);
  return out;
}
// Hovering an item shows its tooltip with the equipped item's tooltip beside it. Both panels form one dark
// region, split by a thin light border where almost no pixel is panel-coloured. Returns each panel, left to right.
function findPanels(img, opts = {}){
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

// Tiny grayscale fingerprint of a region, used to tell when a tooltip has settled or changed.
function thumb(img, box, w = 24, h = 32){
  const out = new Uint8Array(w * h), {width:W, data:d} = img;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    const sx = Math.floor(box.x + (x + 0.5) * box.w / w), sy = Math.floor(box.y + (y + 0.5) * box.h / h), i = (sy * W + sx) * 4;
    out[y * w + x] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  }
  return out;
}
function thumbDiff(a, b){
  if(!a || !b || a.length !== b.length) return 255;
  let s = 0; for(let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// ---------- browser capture ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerP = null;
function loadScript(src){
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load OCR library')); document.head.appendChild(s); });
}
function getWorker(onStatus){
  if(!workerP) workerP = (async () => {
    onStatus && onStatus('Loading OCR engine… (first time only)');
    if(!root.Tesseract) await loadScript(TESSERACT_URL);
    const w = await root.Tesseract.createWorker('eng');
    await w.setParameters({tessedit_pageseg_mode:'6', preserve_interword_spaces:'1'});
    return w;
  })().catch(e => { workerP = null; throw e; });
  return workerP;
}

// Crops the box out of a source canvas, upscales 2x, preprocesses, and OCRs it.
async function ocrBox(srcCanvas, box, onStatus){
  const c = document.createElement('canvas'); c.width = box.w * 2; c.height = box.h * 2;
  const g = c.getContext('2d', {willReadFrequently:true}); g.imageSmoothingEnabled = true;
  g.drawImage(srcCanvas, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height); preprocess(img); g.putImageData(img, 0, 0);
  const w = await getWorker(onStatus);
  const {data} = await w.recognize(c);
  return {text:data.text, canvas:c};
}

// OCRs the hovered item's panel. The hovered tooltip is normally the left one, but if that panel says
// "Currently Equipped" (the game can flip them near the screen edge), read the other one instead.
async function ocrHovered(srcCanvas, panels, onStatus){
  let r = await ocrBox(srcCanvas, panels[0], onStatus);
  if(panels.length > 1 && isEquippedText(r.text)) r = await ocrBox(srcCanvas, panels[1], onStatus);
  return r;
}

// Reads one still image (pasted/dropped screenshot).
async function scanImage(source, onStatus){
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', {willReadFrequently:true}); g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const panels = findPanels(img, {minW:120, minH:150});
  onStatus && onStatus('Reading screenshot…');
  const r = await ocrHovered(c, panels.length ? panels : [{x:0, y:0, w:c.width, h:c.height}], onStatus);
  return {...parseTooltip(r.text), text:r.text, preview:r.canvas, source:c, panels};
}

// Live scanner over a screen share. Calls onItem(parsed) each time a settled tooltip is read, and
// onFrame(info) for every analysed frame so the page can show what the scanner sees.
// Frames are pulled straight from the capture track (MediaStreamTrackProcessor) when the browser supports it,
// which keeps working while the game window covers Chrome; timers and hidden <video> elements get throttled then.
const sameBox = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 6 && Math.abs(a.y - b.y) <= 6 && Math.abs(a.w - b.w) <= 8 && Math.abs(a.h - b.h) <= 8;
function createLiveScanner({onStatus, onItem, onPreview, onFrame, onStop, interval = 400}){
  let stream = null, running = false, busy = false, reader = null, video = null, timer = null;
  let prev = null, lastOcr = null, lastAt = 0, frames = 0, fpsAt = 0, fps = 0;
  const canvas = document.createElement('canvas'), g = canvas.getContext('2d', {willReadFrequently:true});

  // Analyse whatever is currently drawn on the canvas.
  function analyse(){
    const W = canvas.width, H = canvas.height;
    const img = g.getImageData(0, 0, W, H);
    const panels = findPanels(img), box = panels[0];
    frames++; const now = performance.now();
    if(now - fpsAt >= 1000){ fps = frames * 1000 / (now - fpsAt || 1); frames = 0; fpsAt = now; }
    onFrame && onFrame({canvas, width:W, height:H, panels, fps});
    if(!box){ prev = null; if(!busy) onStatus('Watching… no tooltip on screen. Hover over an item.'); return; }
    const t = thumb(img, box);
    // Read once the tooltip has stopped moving (same place and look as last frame), and not the one just read.
    const settled = sameBox(box, prev && prev.box) && thumbDiff(t, prev.t) < 12;
    prev = {box, t};
    if(!settled || busy || (sameBox(box, lastOcr && lastOcr.box) && thumbDiff(t, lastOcr.t) < 12)) return;
    busy = true; lastOcr = {box, t};
    // OCR a snapshot so new frames can keep coming in meanwhile.
    const snap = document.createElement('canvas'); snap.width = W; snap.height = H; snap.getContext('2d').drawImage(canvas, 0, 0);
    onStatus('Reading tooltip…');
    ocrHovered(snap, panels, onStatus).then(r => {
      const p = {...parseTooltip(r.text), text:r.text};
      onPreview && onPreview(r.canvas);
      if(p.lines.length || p.slot >= 0) onItem(p); else onStatus('Found a tooltip but could not read hologram lines from it.');
    }).catch(e => onStatus('OCR error: ' + e.message)).finally(() => { busy = false; });
  }

  async function pump(track){
    reader = new root.MediaStreamTrackProcessor({track}).readable.getReader();
    while(running){
      const {value:frame, done} = await reader.read().catch(() => ({done:true}));
      if(done) break;
      const now = performance.now();
      if(busy || now - lastAt < interval){ frame.close(); continue; }
      lastAt = now;
      const W = frame.displayWidth, H = frame.displayHeight;
      if(canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; }
      g.drawImage(frame, 0, 0, W, H); frame.close();
      try{ analyse(); }catch(e){ onStatus('Scan error: ' + e.message); }
    }
  }
  function tickVideo(){
    if(!video || video.readyState < 2 || busy) return;
    const W = video.videoWidth, H = video.videoHeight; if(!W || !H) return;
    if(canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; }
    g.drawImage(video, 0, 0);
    try{ analyse(); }catch(e){ onStatus('Scan error: ' + e.message); }
  }

  return {
    async start(){
      stream = await navigator.mediaDevices.getDisplayMedia({
        video:{displaySurface:'monitor', cursor:'never', width:{ideal:7680}, height:{ideal:4320}, frameRate:{ideal:5, max:10}},
        audio:false, selfBrowserSurface:'exclude', surfaceSwitching:'include', monitorTypeSurfaces:'include'
      });
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => this.stop());
      running = true;
      getWorker(onStatus).then(() => onStatus('Watching… hover over an item to show its tooltip.'), e => onStatus(e.message));
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
      onStop && onStop();
    },
    get running(){ return running; }
  };
}

const api = {parseTooltip, lineKey, findPanel, findPanels, isEquippedText, preprocess, thumb, thumbDiff, lev, scanImage, createLiveScanner};
if(typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Scanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
