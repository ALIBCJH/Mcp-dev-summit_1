"""Default-deny tool policy, in code.

Two gates. The first runs at startup: filter_menu keeps only listed tools, so
Claude is never offered anything else. The second runs at call time: check
re-validates every request, so a name the model invents is refused with a
readable reason. Nothing the model reads can change this file.

Demo 2 moves the list to a config file; this phase keeps it on one screen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Tool name -> kind. "side_effect" tools get a confirmation step in Phase 5;
# "read_only" tools do not. The tag is recorded now so the trace already
# shows which calls would have needed it.
ALLOWED: dict[str, str] = {
    "search_flights": "read_only",
    "get_flight_status": "read_only",
    "search_hotels": "read_only",
    "book_trip": "side_effect",
    "cancel_booking": "side_effect",
}

NOT_LISTED = "not on the host's allow-list"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    kind: str | None = None  # read_only / side_effect when allowed


def filter_menu(mcp_tools: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]]]:
    """Startup gate. Returns (offered tool dicts, blocked as (name, server, reason))."""
    offered, blocked = [], []
    for tool in mcp_tools:
        if tool["name"] in ALLOWED:
            offered.append(tool)
        else:
            blocked.append((tool["name"], tool["server"], NOT_LISTED))
    return offered, blocked


def check(tool_name: str, args: dict[str, Any]) -> Decision:
    """Call-time gate.

    `args` is unused today but is part of the contract: Phase 5 will look at
    it (for example, refusing cancel_booking on an id the user never saw).
    """
    kind = ALLOWED.get(tool_name)
    if kind is None:
        return Decision(allowed=False, reason=f"Tool '{tool_name}' is {NOT_LISTED}, so it was not run.")
    return Decision(allowed=True, reason=f"'{tool_name}' is allowed ({kind}).", kind=kind)
