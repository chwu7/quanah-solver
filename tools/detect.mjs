// Runs tooltip detection on PNG files (e.g. debug/frames/*.png) and prints the boxes and the reasoning.
// Usage: node tools/detect.mjs [--verbose] file.png [more.png ...]
import {createRequire} from 'node:module';
import {decodePng} from './png.mjs';
const S = createRequire(import.meta.url)('../scanner.js');
const args = process.argv.slice(2), verbose = args.includes('--verbose');
for(const f of args.filter(a => a !== '--verbose')){
  const im = decodePng(f), diag = {}, t0 = performance.now();
  const panels = S.findPanels(im, {}, diag);
  const ms = Math.round(performance.now() - t0);
  console.log(`${f.split(/[\/]/).pop().padEnd(36)} ${im.width}x${im.height} ${String(ms).padStart(3)}ms ${diag.method.padEnd(11)} ` +
    (panels.length ? panels.map(p => `[x${p.x} y${p.y} ${p.w}x${p.h}]`).join(' ') : 'none'));
  if(verbose) console.log(JSON.stringify({lefts:diag.lefts, rights:diag.rights, candidates:diag.candidates}, null, 1));
}
