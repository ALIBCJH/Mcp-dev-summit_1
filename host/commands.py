"""Slash commands shared by the CLI and the web app: /attach and /plan-trip.

Both front ends take one line of traveller input and need the same answer:
is this a message for the model, an attachment for the next message, or a
usage mistake? One module decides, so the two never drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from host.agent import Conversation


class UsageError(Exception):
    """The line was a command but not a valid one. The message is for the person."""


@dataclass
class Expanded:
    # "message": send `text` to the model. "attached": nothing to send yet.
    kind: str
    text: str
    # A line for the trace, e.g. what the prompt expanded to.
    note: str = ""


async def expand(line: str, conv: Conversation, host: Any) -> Expanded:
    """Turn one input line into something the agent loop can run."""
    line = line.strip()

    if line.startswith("/attach "):
        uri = line.split(maxsplit=1)[1]
        owner = next((r["server"] for r in host.resources if r["uri"] == uri), None)
        if owner is None:
            raise UsageError(f"no server offers resource {uri}")
        conv.attach(uri, await host.read_resource(owner, uri))
        return Expanded(kind="attached", text="", note=f"attached {uri}; it will be sent with your next message")

    if line.startswith("/plan-trip "):
        parts = line.split()[1:]
        if len(parts) < 2 or not parts[-1].isdigit():
            raise UsageError("usage: /plan-trip <destination> <days>")
        destination, days = " ".join(parts[:-1]), parts[-1]
        owner = next((p["server"] for p in host.prompts if p["name"] == "plan-trip"), None)
        if owner is None:
            raise UsageError("no server offers the plan-trip prompt")
        rendered = await host.get_prompt(owner, "plan-trip", {"destination": destination, "days": days})
        # The prompt server returns "user: <text>"; the text is what we send.
        text = rendered.split(": ", 1)[1] if rendered.startswith("user: ") else rendered
        return Expanded(kind="message", text=text, note="prompt plan-trip")

    return Expanded(kind="message", text=line)
