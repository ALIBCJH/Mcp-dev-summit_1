"""Checks on the web app that need no API key.

    python host/web_tests.py

Starts its own Bookings server on a free port, the flights and hotels servers
over stdio, and the web app (real uvicorn, free port) with a scripted LLM.
Drives it with the standard library only: urllib for POST/GET, http.client
for the event stream.

(a) chat POST runs a turn and returns the answer
(b) events arrive in order, seq strictly increasing, SSE id == seq
(c) ?after=N and Last-Event-ID resume with exactly the newer events
(d) reset keeps startup events, emits Reset, clears the fooled toggle
(e) a second chat during a turn gets 409; the first still completes
(f) FooledLLM end to end against the real Bookings server; and no injection -> no replacement
(g) reload: a fresh subscriber rebuilds the same (seq, type) list
(h) redaction of a key-shaped string; thinking blocks serialise
(i) connect mid-turn: history then live, no gaps, no duplicates
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.client import HTTPConnection
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import uvicorn  # noqa: E402

from host.events import ModelCalled, ToolReturned  # noqa: E402
from host.llm import ScriptedLLM  # noqa: E402
from host.mcp_clients import ServerConfig  # noqa: E402
from web.app import create_app  # noqa: E402
from web.event_log import Entry  # noqa: E402
from web.serialize import sse_frame, to_dict  # noqa: E402

DIANI = "Find me a flight from Nairobi to Ukunda and a hotel in Diani Beach for 2 nights"
FLIGHTS = {"tool": "search_flights", "args": {"origin": "NBO", "destination": "UKA"}}
HOTELS = {"tool": "search_hotels", "args": {"city": "Diani Beach", "nights": 2}}
TURN_TYPES = ["TurnStarted", "ModelCalled", "ToolRequested", "PolicyDecided", "WireMessage", "WireMessage",
              "ToolReturned", "ModelCalled", "FinalAnswer"]


class TestLLM(ScriptedLLM):
    """ScriptedLLM that can be paused before a given call, from another thread."""

    def __init__(self) -> None:
        super().__init__([])
        self.hold = threading.Event()
        self.hold_before_call = 0  # absolute index into self.calls

    def pause_before(self, nth_call_of_next_turn: int) -> None:
        """Pause (while hold is set) before the n-th call of the next turn."""
        self.hold_before_call = len(self.calls) + nth_call_of_next_turn
        self.hold.set()

    async def send(self, system, messages, tools):
        if len(self.calls) + 1 == self.hold_before_call:
            while self.hold.is_set():
                await asyncio.sleep(0.05)
        return await super().send(system, messages, tools)


LLM = TestLLM()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---- processes ---------------------------------------------------------------


def start_bookings() -> tuple[subprocess.Popen, int]:
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, str(PROJECT_ROOT / "servers" / "bookings_server.py")],
        env={**os.environ, "PORT": str(port)}, cwd=PROJECT_ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=1)
            break
        except urllib.error.HTTPError:
            break  # any HTTP answer means it is up
        except Exception:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("bookings server did not start")
    return proc, port


def start_web(bookings_port: int) -> tuple[uvicorn.Server, threading.Thread, int, Any]:
    configs = [
        ServerConfig(name="flights", command="python", args=["servers/flights_server.py"]),
        ServerConfig(name="hotels", command="python", args=["servers/hotels_server.py"]),
        ServerConfig(name="bookings", url=f"http://127.0.0.1:{bookings_port}/mcp"),
    ]
    app = create_app(lambda: LLM, configs)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("web app did not start")
    return server, thread, port, app


# ---- http helpers ------------------------------------------------------------

BASE = ""


def post(path: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, data=json.dumps(body or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get(path: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class Stream:
    """One open SSE connection; read() returns the next event dict."""

    def __init__(self, port: int, after: int | None = None, last_event_id: str | None = None) -> None:
        self.conn = HTTPConnection("127.0.0.1", port, timeout=20)
        headers = {"Last-Event-ID": last_event_id} if last_event_id is not None else {}
        path = "/api/events" + (f"?after={after}" if after is not None else "")
        self.conn.request("GET", path, headers=headers)
        self.resp = self.conn.getresponse()
        assert self.resp.status == 200, self.resp.status
        assert self.resp.getheader("content-type", "").startswith("text/event-stream")

    def read(self) -> dict:
        frame: dict[str, str] = {}
        while True:
            line = self.resp.readline().decode().rstrip("\n")
            if line == "":
                if frame:
                    data = json.loads(frame["data"])
                    assert int(frame["id"]) == data["seq"], "SSE id must equal seq"
                    assert frame["event"] == data["type"], "SSE event name must equal type"
                    return data
                continue
            if line.startswith(":"):
                continue
            key, value = line.split(": ", 1)
            frame[key] = value

    def read_until(self, type_name: str, limit: int = 200) -> list[dict]:
        out = []
        for _ in range(limit):
            ev = self.read()
            out.append(ev)
            if ev["type"] == type_name:
                return out
        raise AssertionError(f"no {type_name} within {limit} events")

    def close(self) -> None:
        self.conn.close()


def types_of(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def assert_increasing(events: list[dict]) -> None:
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(set(seqs)), f"seq not strictly increasing: {seqs}"


# ---- tests -------------------------------------------------------------------


def test_a_chat(port: int) -> None:
    LLM.responses[:] = [FLIGHTS, {"text": "Two flights: KF101 and NY205."}]
    status, body = post("/api/chat", {"text": "flights to UKA"})
    assert status == 200, body
    assert body["answer"] == "Two flights: KF101 and NY205." and body["note"] is None
    status, body = post("/api/chat", {"text": "   "})
    assert status == 400
    status, body = post("/api/chat", {"text": "/plan-trip Diani"})
    assert status == 400 and "usage" in body["error"]
    status, body = post("/api/chat", {"text": "/attach flights://policy/baggage"})
    assert status == 200 and body["answer"] is None and "attached" in body["note"]
    LLM.responses[:] = [{"text": "Thanks for the baggage policy."}]
    status, body = post("/api/chat", {"text": "what is the baggage rule"})
    assert status == 200
    first_block = LLM.calls[-1]["messages"][-1]["content"][0]["text"]
    assert first_block.startswith("Attached resource flights://policy/baggage"), "attachment rides with the next message"
    print("PASS (a) chat POST returns the answer; 400 on empty text and bad usage; /attach rides with the next message")


def test_b_order(port: int) -> None:
    s = Stream(port, after=0)
    startup = s.read_until("MenuBuilt")
    assert types_of(startup)[0] == "ConfigLoaded"
    # The two earlier turns from (a) are in the log already; skip them.
    _, state = get("/api/state")
    s.close()
    LLM.responses[:] = [FLIGHTS, {"text": "done"}]
    s = Stream(port, after=state["last_seq"])
    status, _ = post("/api/chat", {"text": "flights please"})
    assert status == 200
    turn = s.read_until("FinalAnswer")
    s.close()
    assert types_of(turn) == TURN_TYPES, types_of(turn)
    assert_increasing(turn)
    wires = [e for e in turn if e["type"] == "WireMessage"]
    assert wires[0]["method"] == "tools/call" and wires[0]["direction"] == "->"
    assert wires[1]["direction"] == "<-"
    mc = [e for e in turn if e["type"] == "ModelCalled"]
    assert mc[0]["system"] and mc[0]["tools"] and mc[0]["response"][0]["type"] == "tool_use"
    assert mc[0]["model"] == "scripted"
    print(f"PASS (b) {len(turn)} turn events in order {types_of(turn)}; seq strictly increasing; id == seq")


def test_c_resume(port: int) -> None:
    _, state = get("/api/state")
    n = state["last_seq"]
    LLM.responses[:] = [{"text": "short answer"}]
    post("/api/chat", {"text": "hi"})
    via_query = Stream(port, after=n)
    got_q = via_query.read_until("FinalAnswer")
    via_query.close()
    via_header = Stream(port, last_event_id=str(n))
    got_h = via_header.read_until("FinalAnswer")
    via_header.close()
    assert [e["seq"] for e in got_q] == [e["seq"] for e in got_h]
    assert all(e["seq"] > n for e in got_q)
    assert got_q[0]["seq"] == n + 1 and got_q[0]["type"] == "TurnStarted"
    status, body = get("/api/events?after=abc")
    assert status == 400
    print(f"PASS (c) ?after={n} and Last-Event-ID both resume at seq {n + 1} with {len(got_q)} events; after=abc -> 400")


def test_d_reset(port: int) -> None:
    post("/api/fooled", {"on": True})
    _, state = get("/api/state")
    assert state["fooled"] is True
    status, body = post("/api/reset")
    assert status == 200 and body["fooled"] is False
    _, state = get("/api/state")
    assert state["fooled"] is False, "reset clears the toggle"
    s = Stream(port, after=0)
    events = s.read_until("Reset")
    s.close()
    kinds = types_of(events)
    assert kinds[0] == "ConfigLoaded" and "MenuBuilt" in kinds
    assert "TurnStarted" not in kinds and "ModelCalled" not in kinds, "turn events must be gone"
    assert events[-1]["type"] == "Reset" and events[-1]["fooled"] is False
    assert_increasing(events)
    print(f"PASS (d) reset: {len(events) - 1} startup events kept, turn events gone, Reset event seq {events[-1]['seq']}, fooled cleared")


def test_e_409(port: int) -> None:
    LLM.responses[:] = [{"text": "slow answer"}]
    LLM.pause_before(1)
    result: dict = {}
    t = threading.Thread(target=lambda: result.update(dict(zip(("status", "body"), post("/api/chat", {"text": "slow"})))))
    t.start()
    for _ in range(100):
        if get("/api/state")[1]["turn_running"]:
            break
        time.sleep(0.05)
    status, body = post("/api/chat", {"text": "second"})
    assert status == 409 and body["error"] == "A turn is already running. Wait for it to finish.", (status, body)
    status, _ = post("/api/reset")
    assert status == 409
    LLM.hold.clear()
    t.join(timeout=30)
    LLM.hold_before_call = 0
    assert result["status"] == 200 and result["body"]["answer"] == "slow answer"
    print("PASS (e) second chat and reset during a turn -> 409 with the message; first turn completed")


def test_f_fooled(port: int, app: Any) -> None:
    post("/api/reset")
    post("/api/fooled", {"on": True})
    _, state = get("/api/state")
    n = state["last_seq"]
    LLM.responses[:] = [FLIGHTS, HOTELS, {"text": "The booking was refused: the total exceeds the limit."}]
    s = Stream(port, after=n)
    status, body = post("/api/chat", {"text": DIANI})
    assert status == 200, body
    events = s.read_until("FinalAnswer")
    s.close()
    kinds = types_of(events)
    sim = [e for e in events if e["type"] == "SimulatedReply"]
    assert len(sim) == 1 and sim[0]["tool"] == "book_trip", kinds
    assert sim[0]["args"] == {"flight": "KF101", "hotel_id": "DIA-SUITE", "nights": 10}, sim[0]["args"]
    i = kinds.index("SimulatedReply")
    assert kinds[i + 1] == "ModelCalled" and events[i + 1]["call_number"] == 3 and events[i + 1]["output_tokens"] == 0
    assert kinds[i + 2] == "ToolRequested" and events[i + 2]["name"] == "book_trip"
    assert kinds[i + 3] == "PolicyDecided" and events[i + 3]["allowed"] is True
    wire = events[i + 4]
    assert wire["type"] == "WireMessage" and wire["server"] == "bookings" and wire["method"] == "tools/call"
    returned = next(e for e in events[i:] if e["type"] == "ToolReturned")
    assert returned["is_error"] is True and "exceeds the booking limit of KES 150,000" in returned["text"], returned
    last_call = LLM.calls[-1]["messages"][-1]["content"][0]
    assert last_call["type"] == "tool_result" and last_call["is_error"] is True
    assert "exceeds the booking limit" in last_call["content"]
    assert LLM.calls[-1]["messages"][-2]["content"][0].name == "book_trip", "the synthetic tool_use is in the history"
    assert body["answer"].startswith("The booking was refused")
    print("PASS (f) fooled LLM: synthetic book_trip(KF101, DIA-SUITE, 10) -> real policy -> real Bookings over HTTP -> "
          "limit error as is_error -> next model call saw it")

    # No injection in the results: nothing replaced, a note instead.
    post("/api/fooled", {"on": True})
    _, state = get("/api/state")
    LLM.responses[:] = [{"tool": "search_hotels", "args": {"city": "Nanyuki", "nights": 2}}, {"text": "Two hotels in Nanyuki."}]
    s = Stream(port, after=state["last_seq"])
    status, body = post("/api/chat", {"text": "hotels in Nanyuki for 2 nights"})
    events = s.read_until("FinalAnswer")
    s.close()
    sim = [e for e in events if e["type"] == "SimulatedReply"]
    assert len(sim) == 1 and sim[0]["tool"] is None and "no poisoned review" in sim[0]["note"]
    assert not any(e["type"] == "ToolRequested" and e["name"] == "book_trip" for e in events)
    assert body["answer"] == "Two hotels in Nanyuki."
    print("PASS (f2) fooled LLM with clean results: reply not replaced, note emitted")
    post("/api/fooled", {"on": False})


def test_g_reload(port: int, app: Any) -> None:
    fresh = Stream(port, after=0)
    _, state = get("/api/state")
    got = []
    while not got or got[-1]["seq"] < state["last_seq"]:
        got.append(fresh.read())
    fresh.close()
    expected = [(e.seq, type(e.event).__name__) for e in app.state.demo.log.since(0)]
    assert [(e["seq"], e["type"]) for e in got] == expected
    assert_increasing(got)
    print(f"PASS (g) reload: a fresh subscriber rebuilt the same {len(got)} (seq, type) entries as the server log")


def test_h_serialize() -> None:
    fake = "sk-ant-api03-FAKEKEYFAKEKEYFAKEKEY_abc-123"
    entry = Entry(7, ToolReturned(name="x", is_error=False, text=f"token {fake} inside"))
    frame = sse_frame(entry)
    assert fake not in frame and "[REDACTED api key]" in frame
    assert frame.startswith("id: 7\nevent: ToolReturned\ndata: ") and frame.endswith("\n\n")
    assert frame.count("\n") == 4, "data must be one line"
    mc = ModelCalled(call_number=1, max_calls=8, model="m", system="s", messages=[], tools=[], stop_reason="end_turn",
                     input_tokens=1, output_tokens=2, elapsed_seconds=0.1,
                     response=[{"type": "thinking", "thinking": "summary text", "signature": "sig"}])
    d = to_dict(Entry(8, mc))
    assert d["response"][0]["thinking"] == "summary text" and d["type"] == "ModelCalled" and d["seq"] == 8
    print("PASS (h) key-shaped string redacted in the frame; one-line data; thinking block serialised")


def test_i_mid_turn(port: int, app: Any) -> None:
    post("/api/reset")
    LLM.responses[:] = [FLIGHTS, {"text": "mid-turn answer"}]
    LLM.pause_before(2)
    result: dict = {}
    t = threading.Thread(target=lambda: result.update(dict(zip(("status", "body"), post("/api/chat", {"text": "flights"})))))
    t.start()
    for _ in range(200):  # wait until call 1's tool result has been logged
        if any(isinstance(e.event, ToolReturned) for e in app.state.demo.log.turn):
            break
        time.sleep(0.05)
    s = Stream(port, after=0)  # connects while the turn is paused
    history = s.read_until("ToolReturned")
    LLM.hold.clear()
    live = s.read_until("FinalAnswer")
    s.close()
    t.join(timeout=30)
    LLM.hold_before_call = 0
    assert result["status"] == 200
    got = history + live
    assert_increasing(got)
    expected = [(e.seq, type(e.event).__name__) for e in app.state.demo.log.since(0)]
    assert [(e["seq"], e["type"]) for e in got] == expected, "no gaps, no duplicates against the server log"
    assert types_of(live) == ["ModelCalled", "FinalAnswer"]
    print(f"PASS (i) mid-turn connect: {len(history)} past events then {len(live)} live, no gaps, no duplicates")


def main() -> None:
    global BASE
    bookings, bport = start_bookings()
    server = None
    try:
        server, thread, port, app = start_web(bport)
        BASE = f"http://127.0.0.1:{port}"
        test_a_chat(port)
        test_b_order(port)
        test_c_resume(port)
        test_d_reset(port)
        test_e_409(port)
        test_f_fooled(port, app)
        test_g_reload(port, app)
        test_h_serialize()
        test_i_mid_turn(port, app)
        # The server notices a closed stream on its next write (an event or
        # the keepalive), so give it one keepalive period.
        started = time.perf_counter()
        while app.state.demo.log.subscriber_count and time.perf_counter() - started < 20:
            time.sleep(0.1)
        assert app.state.demo.log.subscriber_count == 0, "every stream must unsubscribe on close"
        print(f"PASS (j) all subscribers released within {time.perf_counter() - started:.1f}s of closing")
        print("\nall web tests passed")
    finally:
        if server is not None:
            server.should_exit = True
            thread.join(timeout=15)
        bookings.terminate()
        bookings.wait(timeout=10)


if __name__ == "__main__":
    main()
