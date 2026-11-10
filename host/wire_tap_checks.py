"""Prove the wire tap on both transports.

    python host/wire_tap_checks.py        (bookings server must be running)

For stdio (flights) and HTTP (bookings):
1. the same calls give identical results with and without the tap
2. the connection exits cleanly: no hang, no task-group errors
and the tap captured the expected JSON-RPC methods.

The HTTP check books a real trip, so each session cancels its own booking
afterwards (try/finally) and leaves the bookings server empty.
"""

from __future__ import annotations

import asyncio
import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host.mcp_clients import MCPServerClient, ServerConfig, ServerUnavailable  # noqa: E402

CONFIGS = {
    "stdio": ServerConfig(name="flights", command="python", args=["servers/flights_server.py"]),
    "http": ServerConfig(name="bookings", url="http://127.0.0.1:9000/mcp"),
}
CALLS = {
    "stdio": [("get_flight_status", {"flight": "KF101"}), ("search_flights", {"origin": "NBO", "destination": "UKA"})],
    "http": [("book_trip", {"flight": "KF101", "hotel_id": "DIA-GALU", "nights": 2})],
}


def _booking_id(text: str) -> str | None:
    """Pull BK-XXXXXXXX out of a book_trip result, so we can cancel it."""
    match = re.search(r"BK-[0-9A-F]{8}", text)
    return match.group(0) if match else None


async def session(cfg: ServerConfig, calls: list, wire: list | None) -> dict:
    on_wire = (lambda s, d, m, j: wire.append((d, m))) if wire is not None else None
    async with MCPServerClient(cfg, on_wire=on_wire) as c:
        out = {
            "tools": [t["name"] for t in await c.list_tools()],
            "resources": [r["uri"] for r in await c.list_resources()],
            "prompts": [p["name"] for p in await c.list_prompts()],
            "calls": [],
        }
        made: list[str] = []  # bookings this session created
        try:
            for name, args in calls:
                r = await c.call_tool(name, args)
                if name == "book_trip" and not r["is_error"] and (bid := _booking_id(r["text"])):
                    made.append(bid)
                # Booking ids are random; compare everything except the id.
                r["text"] = "\n".join(l for l in r["text"].splitlines() if "booking_id" not in l)
                out["calls"].append(r)
        finally:
            # The check must not leave bookings behind in the server's memory,
            # even when an assertion fails further down.
            for bid in made:
                r = await c.call_tool("cancel_booking", {"booking_id": bid})
                print(f"  cleanup: cancel_booking {bid} -> {'FAILED: ' + r['text'] if r['is_error'] else 'cancelled'}")
        return out


async def check(kind: str) -> None:
    cfg, calls = CONFIGS[kind], CALLS[kind]
    plain = await session(cfg, calls, None)
    wire: list = []
    started = time.perf_counter()
    tapped = await asyncio.wait_for(session(cfg, calls, wire), timeout=30)
    elapsed = time.perf_counter() - started

    assert plain == tapped, f"{kind}: results differ with the tap\nplain={plain}\ntapped={tapped}"
    methods = [m for d, m in wire if d == "->"]
    for expected in ("server/discover", "tools/list", "resources/list", "prompts/list", "tools/call"):
        assert expected in methods, f"{kind}: {expected} not captured; got {methods}"
    responses = sum(1 for d, m in wire if d == "<-")
    print(f"PASS {kind}: identical results with/without tap; {len(methods)} requests, {responses} responses captured; "
          f"clean exit in {elapsed:.2f}s")


async def main() -> None:
    await check("stdio")
    try:
        await check("http")
    except ServerUnavailable as exc:
        print(f"FAIL http: {exc}")
        sys.exit(1)
    print("\nwire tap checks passed")


if __name__ == "__main__":
    asyncio.run(main())
