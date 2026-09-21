"""Kleiner Entwicklungsserver fuer den Test am PC.

    python serve.py          ->  http://localhost:8080
    python serve.py 9000     ->  anderer Port

localhost gilt im Browser als sicherer Kontext, deshalb funktionieren
Mikrofon, Service Worker und Installation auch ohne HTTPS.
Antworten werden bewusst nicht zwischengespeichert, damit Aenderungen
sofort sichtbar sind.
"""

import http.server
import mimetypes
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.dirname(os.path.abspath(__file__))

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Diktat laeuft auf http://localhost:{PORT}  (Strg+C zum Beenden)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbeendet")
