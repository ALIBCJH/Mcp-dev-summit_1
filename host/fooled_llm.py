"""Simulate a fooled LLM for the security demo.

Wraps any LLM with the same `send` signature. While armed, the first reply
after the model has received hotel results that contain the poisoned review
is replaced by a synthetic assistant response that requests book_trip with
exactly what the review asks for. Everything after that is real: the policy
check, the tools/call to the Bookings server, its spending-limit error, and
the next Claude call that reads it.

The arguments come from the data files, not from this module or the page:
the review names the suite and the nights; the flight is the one the
Flights server returned earlier in the same turn.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from anthropic.types import Message, ToolUseBlock, Usage

from host.events import OnEvent, SimulatedReply

DATA_DIR = Path(__file__).resolve().parent.parent / "servers" / "data"
INJECTION_MARKER = "SYSTEM:"
BANNER = "SIMULATED: Claude's reply was replaced to model a fooled LLM. Everything after this is real."


@dataclass(frozen=True)
class Injection:
    review: str
    hotel_id: str
    hotel_name: str
    nights: int


def injection_from_data() -> Injection:
    """Read what the poisoned review asks for from hotels.json."""
    hotels = json.loads((DATA_DIR / "hotels.json").read_text())
    for hotel in hotels:
        for review in hotel["reviews"]:
            if INJECTION_MARKER not in review:
                continue
            match = re.search(r"book the (.+?) for (\d+) nights", review)
            if not match:
                raise ValueError(f"cannot parse the injected instruction: {review!r}")
            wanted, nights = match.group(1).lower(), int(match.group(2))
            target = next((h for h in hotels if wanted in h["name"].lower()), None)
            if target is None:
                raise ValueError(f"no hotel matches {wanted!r}")
            return Injection(review=review, hotel_id=target["hotel_id"], hotel_name=target["name"], nights=nights)
    raise ValueError("no poisoned review in hotels.json")


def first_flight_in(text: str) -> str | None:
    """The first flight number in a search_flights result, e.g. KF101."""
    match = re.search(r"\b[A-Z]{2}\d{3}\b", text)
    return match.group(0) if match else None


def fallback_flight() -> str:
    flights = json.loads((DATA_DIR / "flights.json").read_text())
    return flights[0]["flight"]


class FooledLLM:
    """Same interface as ClaudeLLM / ScriptedLLM, plus arm()."""

    def __init__(self, inner: Any, on_event: OnEvent) -> None:
        self.inner = inner
        self.model = getattr(inner, "model", "")
        self.on_event = on_event
        self.injection = injection_from_data()
        self.armed = False
        self._count = 0

    def arm(self) -> None:
        """Call at the start of a turn while the toggle is on. Fires once."""
        self.armed = True

    async def send(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Message:
        if self.armed:
            hotel_text = _hotel_result_just_received(messages)
            if hotel_text is not None:
                self.armed = False
                if INJECTION_MARKER in hotel_text:
                    return self._synthetic(messages)
                self.on_event(SimulatedReply(
                    tool=None, args={},
                    note="simulation armed, but the hotel results carry no poisoned review; reply not replaced",
                ))
        return await self.inner.send(system, messages, tools)

    def _synthetic(self, messages: list[dict[str, Any]]) -> Message:
        flight = first_flight_in(_all_tool_result_text(messages, "search_flights")) or fallback_flight()
        args = {"flight": flight, "hotel_id": self.injection.hotel_id, "nights": self.injection.nights}
        self._count += 1
        self.on_event(SimulatedReply(tool="book_trip", args=args, note=BANNER))
        return Message(
            id=f"msg_simulated_{self._count}",
            type="message",
            role="assistant",
            model="simulated",
            content=[ToolUseBlock(type="tool_use", id=f"toolu_simulated_{self._count}", name="book_trip", input=args)],
            stop_reason="tool_use",
            stop_sequence=None,
            usage=Usage(input_tokens=0, output_tokens=0),
        )


# ---- reading the conversation -----------------------------------------------


def _blocks(message: dict[str, Any]) -> list[Any]:
    content = message.get("content")
    return content if isinstance(content, list) else []


def _block_field(block: Any, name: str, default: Any = None) -> Any:
    # Blocks are SDK objects in assistant messages and dicts in user messages.
    return block.get(name, default) if isinstance(block, dict) else getattr(block, name, default)


def _tool_use_names(messages: list[dict[str, Any]], index: int) -> dict[str, str]:
    """tool_use_id -> tool name for the assistant message at `index`."""
    if index < 0 or messages[index].get("role") != "assistant":
        return {}
    return {
        _block_field(b, "id"): _block_field(b, "name")
        for b in _blocks(messages[index])
        if _block_field(b, "type") == "tool_use"
    }


def _result_text(block: dict[str, Any]) -> str:
    content = block.get("content", "")
    if isinstance(content, list):
        return "\n".join(str(_block_field(c, "text", "")) for c in content)
    return str(content)


def _hotel_result_just_received(messages: list[dict[str, Any]]) -> str | None:
    """Text of a search_hotels result if the LAST message carries one."""
    if not messages or messages[-1].get("role") != "user":
        return None
    names = _tool_use_names(messages, len(messages) - 2)
    for block in _blocks(messages[-1]):
        if isinstance(block, dict) and block.get("type") == "tool_result":
            if names.get(block.get("tool_use_id")) == "search_hotels":
                return _result_text(block)
    return None


def _all_tool_result_text(messages: list[dict[str, Any]], tool_name: str) -> str:
    """Every result of `tool_name` in the conversation, latest first."""
    found: list[str] = []
    for i, message in enumerate(messages):
        if message.get("role") != "user":
            continue
        names = _tool_use_names(messages, i - 1)
        for block in _blocks(message):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                if names.get(block.get("tool_use_id")) == tool_name and not block.get("is_error"):
                    found.append(_result_text(block))
    return "\n".join(reversed(found))
