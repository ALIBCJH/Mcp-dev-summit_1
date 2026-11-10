"""The web demo: traveller chat on the left, bonnet panel on the right.

    python web/app.py          (bookings server must be running; or use start_demo.sh)

Routes
    GET  /                      the page
    GET  /api/state             model, settings, flags, last sequence number
    GET  /api/events?after=N    Server-Sent Events: history after N, then live
    POST /api/chat {"text"}     run one turn; 409 while another is running
    POST /api/reset             clear conversation and turn events, keep startup
    POST /api/fooled {"on"}     the "simulate a fooled LLM" toggle (server side)

One traveller, one conversation, one turn at a time. The page is plain
HTML/JS; this file owns all state.
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host import commands  # noqa: E402
from host.agent import Conversation, run_turn  # noqa: E402
from host.chat import SYSTEM_PROMPT, load_configs  # noqa: E402
from host.events import TurnFailed, TurnStarted  # noqa: E402
from host.fooled_llm import FooledLLM  # noqa: E402
from host.llm import ClaudeLLM  # noqa: E402
from host.mcp_clients import Host, ServerConfig, ServerUnavailable  # noqa: E402
from web.event_log import EventLog  # noqa: E402
from web.serialize import KEEPALIVE, sse_frame  # noqa: E402

STATIC_DIR = Path(__file__).parent / "static"
BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
# A tool call that never returns would otherwise hold the turn lock forever.
TURN_TIMEOUT_SECONDS = 60
KEEPALIVE_SECONDS = 15


class Busy(Exception):
    """A turn is already running."""


class TurnError(Exception):
    """The turn raised; history was rolled back and a TurnFailed event emitted."""


class Demo:
    """All server-side state: the Host, the LLM, the conversation, the log."""

    def __init__(self, llm_factory: Callable[[], Any], configs: list[ServerConfig], system: str) -> None:
        self.llm_factory = llm_factory
        self.configs = configs
        self.system = system
        self.log = EventLog()
        self.conv = Conversation()
        self.turn_lock = asyncio.Lock()
        self.fooled_on = False
        self.host: Host | None = None
        self.llm: FooledLLM | None = None

    async def start(self) -> None:
        inner = self.llm_factory()
        # The wrapper is always in place; it only acts when armed.
        self.llm = FooledLLM(inner, self.log.append)
        self.host = await Host(self.configs, on_event=self.log.append).__aenter__()
        self.log.mark_startup_done()

    async def stop(self) -> None:
        if self.host is not None:
            await self.host.__aexit__(None, None, None)
            self.host = None

    def state(self) -> dict[str, Any]:
        inner = self.llm.inner if self.llm else None
        return {
            "model": getattr(inner, "model", ""),
            "settings": inner.settings() if hasattr(inner, "settings") else "",
            "startup_done": self.log.startup_done,
            "turn_running": self.turn_lock.locked(),
            "fooled": self.fooled_on,
            "last_seq": self.log.last_seq,
            "turn_timeout_seconds": TURN_TIMEOUT_SECONDS,
        }

    async def chat(self, text: str) -> dict[str, Any]:
        assert self.host is not None and self.llm is not None
        if self.turn_lock.locked():
            raise Busy("A turn is already running. Wait for it to finish.")
        async with self.turn_lock:
            expanded = await commands.expand(text, self.conv, self.host)  # UsageError -> 400
            if expanded.kind == "attached":
                return {"answer": None, "note": expanded.note}

            if self.fooled_on:
                self.llm.arm()
            self.log.append(TurnStarted(text=expanded.text, note=expanded.note))
            history_len = len(self.conv.messages)
            try:
                answer = await asyncio.wait_for(
                    run_turn(self.conv, expanded.text, self.llm, self.host,
                             self.host.menu.definitions, self.system, self.log.append),
                    timeout=TURN_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                # API error, timeout, or a server that died: roll the history
                # back so the next turn is clean, and say so in the panel.
                del self.conv.messages[history_len:]
                self.llm.armed = False
                message = (f"turn timed out after {TURN_TIMEOUT_SECONDS}s"
                           if isinstance(exc, asyncio.TimeoutError) else f"{type(exc).__name__}: {exc}")
                self.log.append(TurnFailed(error=message))
                raise TurnError(message) from exc
            return {"answer": answer, "note": expanded.note or None}

    def reset(self) -> dict[str, Any]:
        if self.turn_lock.locked():
            raise Busy("A turn is already running. Wait for it to finish.")
        self.conv = Conversation()
        self.fooled_on = False  # Reset clears the toggle; the header shows it
        if self.llm is not None:
            self.llm.armed = False
        entry = self.log.reset(fooled=self.fooled_on)
        return {"ok": True, "last_seq": entry.seq, "fooled": self.fooled_on}


def create_app(llm_factory: Callable[[], Any], configs: list[ServerConfig], system: str = SYSTEM_PROMPT) -> FastAPI:
    demo = Demo(llm_factory, configs, system)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await demo.start()
        except ServerUnavailable as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            raise
        yield
        await demo.stop()

    app = FastAPI(title="Kenya travel assistant", lifespan=lifespan)
    app.state.demo = demo
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.middleware("http")
    async def no_store(request: Request, call_next):
        # A demo on localhost: the browser must always load the current
        # page and scripts, never a cached copy from an earlier run.
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/state")
    async def state() -> dict[str, Any]:
        return demo.state()

    @app.get("/api/events")
    async def events(request: Request, after: str | None = None) -> Any:
        # ?after=N wins; EventSource sends Last-Event-ID on its own reconnects.
        raw = after if after is not None else request.headers.get("last-event-id", "0")
        try:
            start = int(raw)
        except ValueError:
            return JSONResponse({"error": "after must be an integer"}, status_code=400)

        async def stream():
            history, queue = await demo.log.subscribe(start)
            try:
                for entry in history:
                    yield sse_frame(entry)
                while True:
                    try:
                        entry = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                    except asyncio.TimeoutError:
                        yield KEEPALIVE
                        continue
                    yield sse_frame(entry)
            finally:
                demo.log.unsubscribe(queue)

        headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)

    @app.post("/api/chat")
    async def chat(request: Request) -> Any:
        body = await request.json()
        text = str(body.get("text", "")).strip()
        if not text:
            return JSONResponse({"error": "text is empty"}, status_code=400)
        try:
            return await demo.chat(text)
        except Busy as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except commands.UsageError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        except TurnError as exc:
            return JSONResponse({"error": str(exc)}, status_code=502)

    @app.post("/api/reset")
    async def reset() -> Any:
        try:
            return demo.reset()
        except Busy as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)

    @app.post("/api/fooled")
    async def fooled(request: Request) -> Any:
        if demo.turn_lock.locked():
            return JSONResponse({"error": "A turn is already running. Wait for it to finish."}, status_code=409)
        body = await request.json()
        demo.fooled_on = bool(body.get("on", False))
        return {"fooled": demo.fooled_on}

    return app


def main() -> None:
    import uvicorn

    load_dotenv(PROJECT_ROOT / ".env")
    print(f"Claude API key found: {'yes' if os.environ.get('ANTHROPIC_API_KEY') else 'no'}")
    port = int(os.environ.get("WEB_PORT", DEFAULT_PORT))
    app = create_app(ClaudeLLM, load_configs())
    print(f"Open http://{BIND_HOST}:{port}/")
    uvicorn.run(app, host=BIND_HOST, port=port, log_level="warning")


if __name__ == "__main__":
    main()
