#!/usr/bin/env python3
"""Local dev server for RandPlates.

Why this exists: on Windows, Python's http.server reads the registry for MIME
mappings, and on machines where `.js` is associated with a text editor it
serves JavaScript as text/plain. Browsers enforce strict MIME checking for ES
module scripts (<script type="module">), so the page boots EMPTY with
"Failed to load module script". This server pins the types explicitly.

Run:   python serve.py [port]        (default 8777)
Phone:  it binds your LAN IP too — open the printed http://<lan-ip>:8777
"""
import http.server
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777

MIME = {
    ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".json": "application/json",
    ".html": "text/html", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".woff": "font/woff",
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = path.split("?")[0]
        ext = ext[ext.rfind("."):].lower() if "." in ext else ""
        return MIME.get(ext, super().guess_type(path))
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # dev: never a stale shell
        super().end_headers()

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close()
        return ip
    except Exception:
        return "127.0.0.1"

if __name__ == "__main__":
    print("RandPlates dev server:")
    print(f"  this PC : http://127.0.0.1:{PORT}")
    print(f"  phone   : http://{lan_ip()}:{PORT}   (same WiFi)")
    print("  Ctrl+C to stop")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
