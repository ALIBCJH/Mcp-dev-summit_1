"""Terminal chat: the traveller types, Claude decides, the trace shows why.

Start the bookings server first (python servers/bookings_server.py), then:

    python host/chat.py [--wire]

Commands:
    /plan-trip <destination> <days>   e.g. /plan-trip Diani Beach 2
    /attach <resource-uri>            e.g. /attach flights://policy/baggage
    /quit

--wire also prints every raw JSON-RPC message as it crosses the transport.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host.agent import Conversation, run_turn  # noqa: E402
from host.events import (  # noqa: E402
    ConfigLoaded,
    Event,
    FinalAnswer,
    Handshake,
    MenuBuilt,
    ModelCalled,
    PolicyDecided,
    ServerConnected,
    StartupEvent,
    ToolRequested,
    ToolReturned,
    ToolsDiscovered,
    WireMessage,
)
from host.llm import ClaudeLLM  # noqa: E402
from host.mcp_clients import Host, ServerConfig, ServerUnavailable  # noqa: E402

SYSTEM_PROMPT = (Path(__file__).parent / "system_prompt.txt").read_text()
SHOW_WIRE = "--wire" in sys.argv[1:]


def print_startup(events: list[StartupEvent]) -> None:
    """Five readable lines: config, connected, handshake, discovered, menu.
    Per-server events are joined onto one line each."""
    cfg = next(e for e in events if isinstance(e, ConfigLoaded))
    print("config:      " + f"{len(cfg.servers)} servers from servers.json: "
          + ", ".join(f"{s.name} ({s.kind}: {s.where})" for s in cfg.servers))
    print("connected:   " + ", ".join(e.server for e in events if isinstance(e, ServerConnected)))
    print("handshake:   " + " · ".join(
        f"{e.server} ({e.server_name}) {e.protocol_version} via {e.handshake} [{', '.join(e.capabilities)}]"
        for e in events if isinstance(e, Handshake)))
    print("discovered:  " + " · ".join(
        f"{e.server}: tools {', '.join(e.tool_names) or '-'}"
        + (f"; resources {', '.join(e.resource_uris)}" if e.resource_uris else "")
        + (f"; prompts {', '.join(e.prompt_names)}" if e.prompt_names else "")
        for e in events if isinstance(e, ToolsDiscovered)))
    menu = next(e for e in events if isinstance(e, MenuBuilt))
    blocked = ", ".join(f"{b.name} [{b.server}: {b.reason}]" for b in menu.blocked) or "none"
    print(f"menu:        offered {len(menu.offered)}: {', '.join(menu.offered)} · blocked {len(menu.blocked)}: {blocked}")


def print_event(event: Event) -> None:
    """One readable line (or a few) per turn event. This is the demo's trace."""
    if isinstance(event, WireMessage):
        if SHOW_WIRE:
            body = event.json if len(event.json) <= 300 else event.json[:300] + " …"
            print(f"  wire {event.direction} [{event.server}] {event.method}: {body}")
    elif isinstance(event, ModelCalled):
        print(
            f"  · model call {event.call_number}/{event.max_calls}: stop_reason={event.stop_reason} "
            f"({event.elapsed_seconds}s, in={event.input_tokens} out={event.output_tokens} tokens, "
            f"{len(event.messages)} messages, {len(event.tools)} tools)"
        )
    elif isinstance(event, ToolRequested):
        print(f"  → tool requested: {event.name}({json.dumps(event.args)})")
    elif isinstance(event, PolicyDecided):
        mark = "allowed" if event.allowed else "DENIED"
        print(f"  ⚖ policy: {mark}: {event.reason}")
    elif isinstance(event, ToolReturned):
        flag = "error" if event.is_error else "ok"
        body = event.text if len(event.text) <= 1200 else event.text[:1200] + " …[truncated in trace]"
        print(f"  ← {event.name} returned ({flag}):")
        for line in body.splitlines():
            print(f"      {line}")
    elif isinstance(event, FinalAnswer):
        note = "" if event.reason == "end_turn" else f"  (reason: {event.reason})"
        print(f"  ✓ final answer{note}")
    # Startup events are printed together by print_startup once the Host is up.


def load_configs() -> list[ServerConfig]:
    with open(PROJECT_ROOT / "servers.json") as f:
        return [ServerConfig.from_dict(entry) for entry in json.load(f)]


async def main() -> None:
    load_dotenv(PROJECT_ROOT / ".env")
    print(f"Claude API key found: {'yes' if os.environ.get('ANTHROPIC_API_KEY') else 'no'}")

    llm = ClaudeLLM()
    print(f"Model: {llm.model} ({llm.settings()})")

    async with Host(load_configs(), on_event=print_event) as host:
        print_startup(host.startup_events)
        tools = host.menu.definitions
        print("Type a message, /plan-trip <destination> <days>, /attach <uri>, or /quit.\n")

        conv = Conversation()
        while True:
            try:
                line = input("you> ").strip()
            except EOFError:
                break
            if not line:
                continue
            if line == "/quit":
                break

            if line.startswith("/attach "):
                uri = line.split(maxsplit=1)[1]
                owner = next((r["server"] for r in host.resources if r["uri"] == uri), None)
                if owner is None:
                    print(f"  no server offers resource {uri}\n")
                    continue
                conv.attach(uri, await host.read_resource(owner, uri))
                print(f"  attached {uri}; it will be sent with your next message\n")
                continue

            if line.startswith("/plan-trip "):
                parts = line.split()[1:]
                if len(parts) < 2 or not parts[-1].isdigit():
                    print("  usage: /plan-trip <destination> <days>\n")
                    continue
                destination, days = " ".join(parts[:-1]), parts[-1]
                owner = next((p["server"] for p in host.prompts if p["name"] == "plan-trip"), None)
                if owner is None:
                    print("  no server offers the plan-trip prompt\n")
                    continue
                rendered = await host.get_prompt(owner, "plan-trip", {"destination": destination, "days": days})
                # The prompt server returns "user: <text>"; the text is what we send.
                line = rendered.split(": ", 1)[1] if rendered.startswith("user: ") else rendered
                print("  prompt plan-trip → sending:\n      " + line.replace("\n", "\n      "))

            history_len = len(conv.messages)
            try:
                answer = await run_turn(conv, line, llm, host, tools, SYSTEM_PROMPT, print_event)
            except Exception as exc:
                # An API error (missing key, network, rate limit) must not end
                # the session. Roll the history back so the next turn is clean.
                del conv.messages[history_len:]
                print(f"  ERROR: {type(exc).__name__}: {exc}\n")
                continue
            print(f"\nassistant> {answer}\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ServerUnavailable as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
