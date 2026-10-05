"""chatmap's own host: one local process for the maps of all the chats of the machine.

Python standard library only. The mod starts it when no host answers; sourcerer-link,
when installed, hosts the same classes (`Hub`, `Session`) on its own port instead.

    python3 server/chatmap_server.py serve [--port 40998] [--data <folder>]
    python3 server/chatmap_server.py enabled <session>       (true or false, from the saved map)
    python3 server/chatmap_server.py install | uninstall     (macOS LaunchAgent)

Prints `chatmap on http://127.0.0.1:<port>` once bound.


Routes:
    GET  /                          the index of the registered chats
    POST /sessions/<id>             a chat registers: {cwd, title, page}
    GET  /sessions/<id>/state       the chat's last posted state, or null
    POST /sessions/<id>/state       the chat posts its state; it is saved and sent to the open pages
    GET  /sessions/<id>/inbox       the chat takes the actions queued for it (the queue empties)
    GET  /s/<id>/                   the chat's page (the file the chat registered as `page`)
    GET  /s/<id>/events             server-sent events: one `state` event per posted state
    POST /s/<id>/action             the page queues an action for the chat
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

INDEX = Path(__file__).parent / "index.html"
KEEP_ALIVE = 15


class Session:
    """One chat: its registration, its state, its action queue and its open event streams."""

    def __init__(self, hub: "Hub", sid: str):
        self.hub = hub
        self.sid = sid
        self.lock = threading.Lock()
        self.info: dict = {}
        self._state = None
        self.actions: list[dict] = []
        self.listeners: list[queue.Queue] = []

    @property
    def path(self) -> Path:
        return self.hub.data / "chatmap" / f"{self.sid}.json"

    @property
    def state(self):
        with self.lock:
            return self._state

    def load(self) -> None:
        if self.path.exists():
            self._state = json.loads(self.path.read_text())

    def register(self, info: dict) -> None:
        with self.lock:
            self.info = info

    def publish(self, state) -> None:
        payload = json.dumps(state)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(payload)
        with self.lock:
            self._state = state
            listeners = list(self.listeners)
        for listener in listeners:
            listener.put(payload)

    def listen(self) -> queue.Queue:
        listener: queue.Queue = queue.Queue()
        with self.lock:
            self.listeners.append(listener)
            if self._state is not None:
                listener.put(json.dumps(self._state))
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

    def summary(self) -> dict:
        state = self.state or {}
        with self.lock:
            info = dict(self.info)
            streams = len(self.listeners)
        return {
            "id": self.sid,
            "title": info.get("title") or state.get("title") or self.sid[:8],
            "cwd": info.get("cwd", ""),
            "registered": bool(info),
            "enabled": state.get("enabled", False),
            "topics": len(state.get("topics", {})),
            "logical": len(state.get("logical", [])),
            "physical": len(state.get("physical", [])),
            "pages": streams,
        }


class Hub:
    """All the chats of this machine, keyed by session id; their states live under `data`."""

    def __init__(self, data: Path):
        self.data = data
        self.lock = threading.Lock()
        self.sessions: dict[str, Session] = {}
        for saved in sorted((data / "chatmap").glob("*.json")):
            self.session(saved.stem)

    def session(self, sid: str) -> Session:
        with self.lock:
            if sid not in self.sessions:
                session = Session(self, sid)
                session.load()
                self.sessions[sid] = session
            return self.sessions[sid]

    def index(self) -> list[dict]:
        with self.lock:
            sessions = list(self.sessions.values())
        return [session.summary() for session in sessions]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        """Requests are not logged."""

    @property
    def hub(self) -> Hub:
        return cast(HubServer, self.server).hub

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

    def not_found(self) -> None:
        self.send_body(404, b"not found", "text/plain")

    def do_GET(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if parts == [""]:
            page = INDEX.read_text().replace("/*DATA*/null", json.dumps(self.hub.index()).replace("</", "<\\/"))
            self.send_body(200, page.encode(), "text/html; charset=utf-8")
        elif parts == ["sessions"]:
            self.send_json(self.hub.index())
        elif len(parts) == 3 and parts[0] == "sessions" and parts[2] == "state":
            self.send_json(self.hub.session(parts[1]).state)
        elif len(parts) == 3 and parts[0] == "sessions" and parts[2] == "inbox":
            self.send_json(self.hub.session(parts[1]).take_actions())
        elif len(parts) == 2 and parts[0] == "s" and not self.path.endswith("/"):
            self.send_response(301)
            self.send_header("Location", f"/s/{parts[1]}/")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif len(parts) == 2 and parts[0] == "s":
            self.send_page(self.hub.session(parts[1]))
        elif len(parts) == 3 and parts[0] == "s" and parts[2] == "events":
            self.stream_events(self.hub.session(parts[1]))
        else:
            self.not_found()

    def do_POST(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 2 and parts[0] == "sessions":
            self.hub.session(parts[1]).register(self.read_json())
            self.send_json({"ok": True})
        elif len(parts) == 3 and parts[0] == "sessions" and parts[2] == "state":
            self.hub.session(parts[1]).publish(self.read_json())
            self.send_json({"ok": True})
        elif len(parts) == 3 and parts[0] == "s" and parts[2] == "action":
            self.hub.session(parts[1]).queue_action(self.read_json())
            self.send_json({"ok": True})
        else:
            self.not_found()

    def send_page(self, session: Session) -> None:
        page = session.info.get("page")
        if not page:
            self.send_body(404, b"this chat has not registered since the host started", "text/plain")
            return
        data = json.dumps(session.state).replace("</", "<\\/")
        self.send_body(200, Path(page).read_text().replace("/*DATA*/null", data).encode(), "text/html; charset=utf-8")

    def stream_events(self, session: Session) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        listener = session.listen()
        try:
            while True:
                try:
                    payload = listener.get(timeout=KEEP_ALIVE)
                    self.wfile.write(f"event: state\ndata: {payload}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            session.forget(listener)


class HubServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, hub: Hub, port: int):
        self.hub = hub
        super().__init__(("127.0.0.1", port), Handler)


PORT = 40998
LABEL = "com.genro.chatmap"


def data_folder() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "chatmap"
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"]) / "chatmap"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "chatmap"


def launch_agent() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def plist() -> str:
    logs = data_folder() / "logs"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{sys.executable}</string>
    <string>{Path(__file__).resolve()}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{logs / "host.log"}</string>
  <key>StandardErrorPath</key><string>{logs / "host.log"}</string>
</dict>
</plist>
"""


def install() -> str:
    if sys.platform != "darwin":
        raise NotImplementedError(f"no service installer for {sys.platform} yet; run `chatmap_server.py serve` by hand")
    (data_folder() / "logs").mkdir(parents=True, exist_ok=True)
    agent = launch_agent()
    domain = f"gui/{os.getuid()}"
    if agent.exists():
        subprocess.run(["launchctl", "bootout", domain, str(agent)], check=False)
    agent.write_text(plist())
    subprocess.run(["launchctl", "bootstrap", domain, str(agent)], check=True)
    return f"installed {agent}"


def uninstall() -> str:
    if sys.platform != "darwin":
        raise NotImplementedError(f"no service installer for {sys.platform} yet")
    agent = launch_agent()
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(agent)], check=False)
    agent.unlink(missing_ok=True)
    return f"removed {agent}"


def serve(port: int, data: Path) -> None:
    server = HubServer(Hub(data), port)
    print(f"chatmap on http://127.0.0.1:{server.server_address[1]}, data in {data}", flush=True)
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="chatmap's own host for the maps of all the chats of this machine.")
    commands = parser.add_subparsers(dest="command", required=True)
    serving = commands.add_parser("serve", help="run the host in the foreground")
    serving.add_argument("--port", type=int, default=PORT)
    serving.add_argument("--data", type=Path, default=data_folder())
    enabled = commands.add_parser("enabled", help="print whether a chat's saved map is on, without starting the host")
    enabled.add_argument("session")
    commands.add_parser("install", help="install the host as a user service started at login (macOS)")
    commands.add_parser("uninstall", help="stop and remove the user service (macOS)")
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.port, args.data)
    elif args.command == "enabled":
        print("true" if (Hub(data_folder()).session(args.session).state or {}).get("enabled") is True else "false")
    elif args.command == "install":
        print(install())
    else:
        print(uninstall())


if __name__ == "__main__":
    main()
