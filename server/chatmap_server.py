"""Serve the chatmap grid of one session and relay actions between page and mod.

Started by the mod with `$.process.spawn`; it lives as long as the mod.

    python3 server/chatmap_server.py --root <plugin root> --port <port>

Prints `chatmap on http://127.0.0.1:<port>` once bound. The mod derives the
port from the session id, so a page stays valid across mod reloads; while the
previous server of the same session is still releasing it, binding is retried.

Routes:
    GET  /          the grid page
    GET  /state     the map as the mod last posted it
    POST /state     the mod posts the map; every open page receives it
    GET  /events    server-sent events: one `state` event per posted map
    POST /action    the page queues an action for the mod
    GET  /actions   the mod takes the queued actions (the queue empties)
"""

import argparse
import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Hub:
    """The map, the action queue and the open event streams of one session."""

    def __init__(self, page: Path):
        self.page = page
        self.lock = threading.Lock()
        self.state: dict | None = None
        self.actions: list[dict] = []
        self.listeners: list[queue.Queue] = []

    def publish(self, state: dict) -> None:
        with self.lock:
            self.state = state
            listeners = list(self.listeners)
        payload = json.dumps(state)
        for listener in listeners:
            listener.put(payload)

    def listen(self) -> queue.Queue:
        listener: queue.Queue = queue.Queue()
        with self.lock:
            self.listeners.append(listener)
        return listener

    def forget(self, listener: queue.Queue) -> None:
        with self.lock:
            self.listeners.remove(listener)

    def queue_action(self, action: dict) -> None:
        with self.lock:
            self.actions.append(action)

    def take_actions(self) -> list[dict]:
        with self.lock:
            taken, self.actions = self.actions, []
        return taken


class Handler(BaseHTTPRequestHandler):
    hub: Hub

    def log_message(self, format: str, *args) -> None:
        """Requests are not logged: the mod reads stdout for the URL only."""

    def send_body(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value) -> None:
        self.send_body(200, json.dumps(value).encode(), "application/json")

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"null")

    def do_GET(self) -> None:
        if self.path == "/":
            with self.hub.lock:
                state = self.hub.state
            data = json.dumps(state).replace("</", "<\\/")
            page = self.hub.page.read_text().replace("/*DATA*/null", data)
            self.send_body(200, page.encode(), "text/html; charset=utf-8")
        elif self.path == "/state":
            with self.hub.lock:
                self.send_json(self.hub.state)
        elif self.path == "/actions":
            self.send_json(self.hub.take_actions())
        elif self.path == "/events":
            self.stream_events()
        else:
            self.send_body(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        if self.path == "/state":
            self.hub.publish(self.read_json())
            self.send_json({"ok": True})
        elif self.path == "/action":
            self.hub.queue_action(self.read_json())
            self.send_json({"ok": True})
        else:
            self.send_body(404, b"not found", "text/plain")

    def stream_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        listener = self.hub.listen()
        with self.hub.lock:
            if self.hub.state is not None:
                listener.put(json.dumps(self.hub.state))
        try:
            while True:
                try:
                    payload = listener.get(timeout=15)
                    self.wfile.write(f"event: state\ndata: {payload}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.hub.forget(listener)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the chatmap grid of one session.")
    parser.add_argument("--root", type=Path, required=True, help="the plugin root")
    parser.add_argument("--port", type=int, required=True, help="the port to bind")
    parser.add_argument("--bind-wait", type=float, default=10.0, help="seconds to retry a busy port")
    args = parser.parse_args()

    Handler.hub = Hub(args.root / "tools" / "grid.html")
    deadline = time.monotonic() + args.bind_wait
    while True:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
            break
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)
    server.daemon_threads = True
    print(f"chatmap on http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
