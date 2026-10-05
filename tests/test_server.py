import json
import threading
import urllib.request
from pathlib import Path

import pytest

from chatmap_server import Hub, HubServer


@pytest.fixture
def running(tmp_path: Path):
    server = HubServer(Hub(tmp_path), 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", tmp_path
    server.shutdown()
    server.server_close()


def call(url: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as reply:
        return reply.read().decode()


def test_state_is_saved_and_returned(running):
    base, data = running
    assert json.loads(call(f"{base}/sessions/abc/state")) is None
    call(f"{base}/sessions/abc/state", {"enabled": True, "physical": [{"n": 1}]})
    assert json.loads(call(f"{base}/sessions/abc/state"))["physical"] == [{"n": 1}]
    assert json.loads((data / "chatmap" / "abc.json").read_text())["enabled"] is True


def test_saved_state_survives_a_restart(tmp_path: Path):
    (tmp_path / "chatmap").mkdir()
    (tmp_path / "chatmap" / "old.json").write_text(json.dumps({"title": "old chat", "logical": [1, 2]}))
    hub = Hub(tmp_path)
    assert [s["title"] for s in hub.index()] == ["old chat"]
    assert hub.session("old").state == {"title": "old chat", "logical": [1, 2]}


def test_page_actions_reach_the_inbox_once(running):
    base, _ = running
    call(f"{base}/s/abc/action", {"kind": "reorganise"})
    assert json.loads(call(f"{base}/sessions/abc/inbox")) == [{"kind": "reorganise"}]
    assert json.loads(call(f"{base}/sessions/abc/inbox")) == []


def test_page_is_the_registered_file_with_the_state_embedded(running, tmp_path: Path):
    base, _ = running
    page = tmp_path / "grid.html"
    page.write_text("<script>const DATA = /*DATA*/null;</script>")
    call(f"{base}/sessions/abc", {"cwd": "/repo", "title": "repo", "page": str(page)})
    call(f"{base}/sessions/abc/state", {"title": "repo"})
    assert call(f"{base}/s/abc/") == '<script>const DATA = {"title": "repo"};</script>'


def test_index_lists_registered_chats(running):
    base, _ = running
    call(f"{base}/sessions/abc", {"cwd": "/repo", "title": "repo", "page": "/nowhere"})
    call(f"{base}/sessions/abc/state", {"enabled": True, "topics": {"t1": {}}, "logical": [], "physical": [{}]})
    [chat] = json.loads(call(f"{base}/sessions"))
    assert chat["title"] == "repo" and chat["enabled"] is True and chat["topics"] == 1 and chat["physical"] == 1
    assert '"title": "repo"' in call(f"{base}/")
