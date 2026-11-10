"""Phase 2 smoke test: three servers, tools + a resource + a prompt, two errors.

Start the bookings server first, in another terminal:

    python servers/bookings_server.py

Then, from the project root (servers.json paths are relative to it):

    python host/smoke_test.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Allow `from host.mcp_clients import ...` when run as a plain script.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host.mcp_clients import Host, ServerConfig, ServerUnavailable  # noqa: E402


def check_env() -> None:
    # Presence only. Printing even part of the key on a projector is a leak.
    load_dotenv(PROJECT_ROOT / ".env")
    found = "yes" if os.environ.get("ANTHROPIC_API_KEY") else "no"
    print(f"Claude API key found: {found}")


def load_configs() -> list[ServerConfig]:
    with open(PROJECT_ROOT / "servers.json") as f:
        return [ServerConfig.from_dict(entry) for entry in json.load(f)]


def one_line(text: str) -> str:
    return " ".join(text.split())


def show(title: str, result: dict) -> None:
    print(f"\n{title}")
    print(f"  is_error={result['is_error']}")
    for line in result["text"].splitlines():
        print(f"  {line}")


def pretty(result: dict) -> dict:
    # Tool results come back as JSON text. Re-indent so reviews are readable.
    if not result["is_error"]:
        try:
            result = {**result, "text": json.dumps(json.loads(result["text"]), indent=2)}
        except ValueError:
            pass
    return result


async def main() -> None:
    check_env()
    configs = load_configs()

    async with Host(configs) as host:
        # 1. The full menu, labelled by server.
        print("\nTools:")
        for t in host.tools:
            print(f"  [{t['server']}] {t['name']}: {one_line(t['description'])}")
        print("\nResources:")
        for r in host.resources:
            print(f"  [{r['server']}] {r['uri']}: {one_line(r['description'])}")
        print("\nPrompts:")
        for p in host.prompts:
            args = ", ".join(a["name"] for a in p["arguments"])
            print(f"  [{p['server']}] {p['name']}({args}): {one_line(p['description'])}")

        # 2–4. Happy-path searches. The main demo trip: Nairobi to Diani Beach.
        show("search_flights(NBO -> UKA):",
             pretty(await host.run_tool("search_flights", {"origin": "NBO", "destination": "UKA"})))
        show("get_flight_status(NY205):",
             await host.run_tool("get_flight_status", {"flight": "NY205"}))
        show("search_hotels(Diani Beach, 2 nights) — note the poisoned review on DIA-CORAL:",
             pretty(await host.run_tool("search_hotels", {"city": "Diani Beach", "nights": 2})))

        # 5. Resources: read, not called.
        print("\nResource flights://policy/baggage:")
        for line in (await host.read_resource("flights", "flights://policy/baggage")).splitlines():
            print(f"  {line}")
        print("\nResource hotels://guide/kenya:")
        for line in (await host.read_resource("hotels", "hotels://guide/kenya")).splitlines():
            print(f"  {line}")

        # 6. A prompt is a template the person picks. Arguments are strings on the wire.
        print("\nPrompt plan-trip(destination=Diani Beach, days=2):")
        for line in (await host.get_prompt("hotels", "plan-trip", {"destination": "Diani Beach", "days": "2"})).splitlines():
            print(f"  {line}")

        # 7. Book, then cancel. The server prices it: 15,500 + 2 x 16,500 = 48,500.
        booked = await host.run_tool("book_trip", {"flight": "KF101", "hotel_id": "DIA-GALU", "nights": 2})
        show("book_trip(KF101, DIA-GALU, 2 nights):", pretty(booked))
        if not booked["is_error"]:
            booking_id = json.loads(booked["text"])["booking_id"]
            show(f"cancel_booking({booking_id}):",
                 pretty(await host.run_tool("cancel_booking", {"booking_id": booking_id})))

        # 8. Two errors the LLM is meant to read and recover from.
        show("book_trip(KF101, DIA-SUITE, 10 nights) [over the limit]:",
             await host.run_tool("book_trip", {"flight": "KF101", "hotel_id": "DIA-SUITE", "nights": 10}))
        show("search_flights(Diani -> NBO) [bad code]:",
             await host.run_tool("search_flights", {"origin": "Diani", "destination": "NBO"}))

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ServerUnavailable as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
