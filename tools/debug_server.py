"""Local debug server for the scanner.

Serves the solver at http://localhost:8000/?debug and records what the scanner sees:
  debug/scan-log.jsonl   one JSON line per event (frames ~1/s, every OCR attempt, pasted screenshots)
  debug/frames/*.png     full captured frames (every ~5s, and each OCR attempt) plus the OCR crops

Usage (from the repo root):  python tools/debug_server.py
Nothing leaves your machine; delete the debug/ folder whenever you like.
"""
import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG_DIR = os.path.join(ROOT, 'debug')
FRAMES_DIR = os.path.join(DEBUG_DIR, 'frames')
LOG_PATH = os.path.join(DEBUG_DIR, 'scan-log.jsonl')
MAX_FRAMES = 200  # oldest frames are deleted beyond this


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
            with open(LOG_PATH, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
            if entry.get('type') != 'frame':
                p = entry.get('parsed') or {}
                print(f"[{entry.get('type')}] slot={p.get('slot')} lines={p.get('lines')} issues={p.get('issues')}"
                      if p else f"[{entry.get('type')}] {entry.get('message', '')}", flush=True)
            return self._reply(204)
        if url.path == '/debug/frame':
            kind = ''.join(c for c in parse_qs(url.query).get('kind', ['frame'])[0] if c.isalnum() or c == '-')[:40]
            name = f"{time.strftime('%H%M%S')}-{int(time.time() * 1000) % 1000:03d}-{kind}.png"
            with open(os.path.join(FRAMES_DIR, name), 'wb') as f:
                f.write(body)
            frames = sorted(os.listdir(FRAMES_DIR))
            for old in frames[:-MAX_FRAMES]:
                os.remove(os.path.join(FRAMES_DIR, old))
            return self._reply(204)
        self._reply(404)

    def _reply(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(FRAMES_DIR, exist_ok=True)
    print(f'Scanner debug server: open http://localhost:{port}/?debug')
    print(f'Logs:   {LOG_PATH}')
    print(f'Frames: {FRAMES_DIR}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
