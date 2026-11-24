"""Local debug server for the scanner.

Serves the solver at http://localhost:8000/?debug and records everything the scanner does:
  debug/scan-log.jsonl   one JSON line per event: every analysed frame (detection boxes, edge candidates and
                         why each was kept or dropped, settle/new-item metrics, the decision taken), OCR engine
                         state, every OCR pass (raw text, confidence, timing), parse results, review-list and
                         import decisions, UI actions, status messages and errors
  debug/frames/*.png     the full captured frame whenever the scanner's decision changes, every 5s, and for every
                         OCR attempt (plus the preprocessed crop that was OCR'd)
Each run starts fresh; the previous run is kept as scan-log.prev.jsonl and frames-prev/.

Usage (from the repo root):  python tools/debug_server.py [port]
Nothing leaves your machine; delete the debug/ folder whenever you like.
"""
import json
import os
import shutil
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG_DIR = os.path.join(ROOT, 'debug')
FRAMES_DIR = os.path.join(DEBUG_DIR, 'frames')
LOG_PATH = os.path.join(DEBUG_DIR, 'scan-log.jsonl')
MAX_FRAMES = 400  # oldest frames are deleted beyond this
LOCK = threading.Lock()  # requests are handled on several threads; keep log lines whole
FRAME_NO = 0


def box(b):
    return f"[{b['x']},{b['y']} {b['w']}x{b['h']}]" if isinstance(b, dict) else str(b)


def summary(e):
    """One readable console line per event."""
    t = e.get('type')
    if t == 'frame':
        parts = [f"#{e.get('n')}", e.get('decision', '?'), f"{e.get('detectMs')}ms",
                 'panels=' + (' '.join(box(p) for p in e.get('panels', [])) or 'none'),
                 f"edges L{len(e.get('lefts') or [])}/R{len(e.get('rights') or [])}"]
        for c in e.get('candidates') or []:
            if c.get('drop'):
                parts.append(f"dropped({c['drop']})")
        for k in ('vsPrev', 'vsLastRead'):
            if e.get(k):
                parts.append(f"{k}=box±{e[k]['boxDelta']},change {e[k]['change']}")
        return 'frame ' + ' '.join(parts)
    if t == 'ocr-pass':
        text = ' / '.join(l for l in (e.get('text') or '').splitlines() if l.strip())
        return (f"ocr-pass panel={e.get('panel')} {e.get('ms')}ms conf={e.get('confidence')} equipped={e.get('equipped')} "
                f"score={e.get('score')} slot={e.get('slot')} lines={e.get('lines')}\n    text: {text[:400]}")
    if t == 'parse':
        return (f"parse [{e.get('source')}] slot={e.get('slot')} lines={e.get('lines')} issues={e.get('issues')} "
                f"conf={e.get('confidence')} raw={e.get('raw')}")
    rest = {k: v for k, v in e.items() if k not in ('type', 'at')}
    return f"{t} {json.dumps(rest, ensure_ascii=False)[:400]}"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith('/debug/'):
            super().log_message(fmt, *args)

    def do_POST(self):
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if url.path == '/debug/log':
            try:
                entry = json.loads(body)
            except ValueError:
                return self._reply(400)
            with LOCK:
                with open(LOG_PATH, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
                print(time.strftime('%H:%M:%S'), summary(entry), flush=True)
            return self._reply(204)
        if url.path == '/debug/frame':
            global FRAME_NO
            raw_kind = unquote(parse_qs(url.query).get('kind', ['frame'])[0])
            kind = ''.join(c for c in raw_kind if c.isalnum() or c == '-')[:48]
            with LOCK:
                FRAME_NO += 1
                name = f"{time.strftime('%H%M%S')}-{FRAME_NO:04d}-{kind}.png"
                with open(os.path.join(FRAMES_DIR, name), 'wb') as f:
                    f.write(body)
                print(time.strftime('%H:%M:%S'), 'saved frame', name, flush=True)
                frames = sorted(os.listdir(FRAMES_DIR))
                for old in frames[:-MAX_FRAMES]:
                    os.remove(os.path.join(FRAMES_DIR, old))
            return self._reply(204)
        self._reply(404)

    def _reply(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()


def rotate():
    os.makedirs(DEBUG_DIR, exist_ok=True)
    if os.path.exists(LOG_PATH):
        os.replace(LOG_PATH, os.path.join(DEBUG_DIR, 'scan-log.prev.jsonl'))
    prev_frames = os.path.join(DEBUG_DIR, 'frames-prev')
    if os.path.isdir(FRAMES_DIR) and os.listdir(FRAMES_DIR):
        shutil.rmtree(prev_frames, ignore_errors=True)
        os.replace(FRAMES_DIR, prev_frames)
    os.makedirs(FRAMES_DIR, exist_ok=True)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Windows consoles default to a legacy code page; never let a "…" or "±" in a log line crash a request.
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass
    rotate()
    print(f'Scanner debug server: open http://localhost:{port}/?debug')
    print(f'Logs:   {LOG_PATH}')
    print(f'Frames: {FRAMES_DIR}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
