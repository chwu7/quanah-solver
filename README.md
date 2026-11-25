# Quanah 3-Line Solver

A single-page tool that picks the best Hat / Top / Bottom / Cape / Glove / Shoe combination from the Hologram lines you own to get as close to **18/18** as possible.

- Lines: Dimensional Leap, White Hole, Registry, ATK, Damage, Crit DMG, Pirate, Warrior, Mage, Thief, Bowman (plus "Other" filler)
- Solves Meta (Post-Nerf) 18/18 and Legacy Registry 18/18 at the same time and shows which one you are closer to
- Exact dynamic-programming solver, plus a "what to hunt next" list
- Line priorities (1-10): higher-priority lines are filled first and never traded for lower ones; equal priorities just maximize line count. Presets: "Max total lines" and "Core first" (DL/WH/Registry → ATK → Crit DMG → rest)
- **Scan from game**: share your MapleStory window and hover over items. Each tooltip is read with OCR (Tesseract.js, in the browser) into a review list you can import. It only reads screen pixels. You can also paste or drop tooltip screenshots. Items already recorded (same slot and same lines, in any order) are skipped automatically, so you can rescan freely.
- **Jewels tab**: record the 3 jewel slot colours (Red, Gray, Purple, Blue, Green, Prismatic) on each item, per slot. Set your own 18-slot jewel target (rows of "N slots, any of these colours", e.g. 6 Prismatic + 12 Red/Gray/Green), start from the Warrior preset (4 Prismatic + 14 Red/Gray/Green), and save your own named presets. Jewel solving is not built yet.
- Data stays in your browser (localStorage); export/import backups as JSON

Line caps and target sets follow the [Quanah World Utilities](https://altord.github.io/QuanahWorldUtilities/Quanah%20World%20Utilities.htm) 3-Line Assistant.

Tests: `node --test test/parse.test.mjs`

Scanner debugging: run `python tools/debug_server.py`, open http://localhost:8000/?debug and scan as usual. Every frame decision, edge candidate, OCR pass (with raw text), parse result, item decision, UI action and error goes to `debug/scan-log.jsonl`, with captured frames in `debug/frames/` (git-ignored, never uploaded; each run keeps the previous one as `.prev`). `node tools/detect.mjs debug/frames/*.png` re-runs detection offline.
