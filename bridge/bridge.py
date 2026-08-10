#!/usr/bin/env python3
"""卷灵本地桥：页面事件直存 data/。
用法：python3 bridge/bridge.py  （建议后台：> /dev/null 2>&1 &）
端点：GET /health → {"ok":true}
     POST /save  {"relpath":"sessions/xxx.json","data":{...}} → 落盘 data/<relpath>"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, re, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
SAFE = re.compile(r'^(sessions|profile)/[\w.-]+\.json$')
PORT = int(os.environ.get('GP_PORT', '8756'))

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        if self.path == '/list':
            rows = []
            sdir = os.path.join(DATA, 'sessions')
            if os.path.isdir(sdir):
                for fn in sorted(os.listdir(sdir)):
                    if not fn.endswith('.json'):
                        continue
                    try:
                        with open(os.path.join(sdir, fn)) as f:
                            d = json.load(f)
                        r = d.get('result', {})
                        rows.append({"id": d.get("id"), "paper_id": d.get("paper_id"),
                                     "started_at": d.get("started_at"), "win": r.get("win"),
                                     "you": r.get("your_total_sec"), "ghost": r.get("ghost_submit_sec")})
                    except Exception:
                        pass
            body = json.dumps(rows, ensure_ascii=False).encode()
        elif self.path == '/latest':
            sdir = os.path.join(DATA, 'sessions')
            files = sorted(f for f in os.listdir(sdir) if f.endswith('.json')) if os.path.isdir(sdir) else []
            body = b'null'
            if files:
                with open(os.path.join(sdir, files[-1]), 'rb') as f:
                    body = f.read()
        else:
            body = json.dumps({"ok": True, "ts": time.time()}).encode()
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self.path.startswith('/save'):
            self.send_response(404); self._cors(); self.end_headers(); return
        try:
            n = int(self.headers.get('Content-Length', 0))
            req = json.loads(self.rfile.read(n) or b'{}')
            rel = req.get('relpath', '')
            if not SAFE.match(rel):
                raise ValueError('bad relpath: ' + rel)
            dst = os.path.join(DATA, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'w') as f:
                json.dump(req.get('data'), f, ensure_ascii=False, indent=1)
            body = json.dumps({"saved": True, "path": dst}).encode()
            self.send_response(200)
        except Exception as e:
            body = json.dumps({"saved": False, "error": str(e)}).encode()
            self.send_response(400)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

if __name__ == '__main__':
    print(f'卷灵本地桥 @ 127.0.0.1:{PORT} → {DATA}')
    HTTPServer(('127.0.0.1', PORT), H).serve_forever()
