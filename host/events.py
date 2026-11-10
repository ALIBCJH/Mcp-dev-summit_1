"""Trace events, emitted by the Host at startup and by the agent loop per turn.

Nothing here prints. Each event goes to an on_event callback; the CLI prints
lines (Phase 3) and the web page streams them into the bonnet panel (Phase 4).
No event ever carries the API key: no module hands it to another, so there is
nothing to leak.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Union

# ---- startup, in this order -------------------------------------------------


@dataclass
class ServerSummary:
    name: str
    kind: str  # "stdio" or "http"
    where: str  # command + args, or the URL


@dataclass
class ConfigLoaded:
    servers: list[ServerSummary]


@dataclass
class ServerConnected:
    server: str
    kind: str
    where: str


@dataclass
class Handshake:
    server: str
    protocol_version: str
    server_name: str
    capabilities: list[str]  # e.g. ["prompts", "resources", "tools"]
    handshake: str  # "discover" on this SDK: there is no initialize request


@dataclass
class ToolsDiscovered:
    server: str
    tool_names: list[str]
    resource_uris: list[str]
    prompt_names: list[str]


@dataclass
class BlockedTool:
    name: str
    server: str
    reason: str


@dataclass
class MenuBuilt:
    offered: list[str]
    blocked: list[BlockedTool]


# ---- per turn ----------------------------------------------------------------


@dataclass
class ModelCalled:
    call_number: int
    max_calls: int
    model: str
    # The full request, as sent. messages is a snapshot of plain dicts so a
    # later listener can serialise it; the live list in Conversation keeps
    # the SDK objects so thinking blocks round-trip untouched.
    system: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    stop_reason: str
    input_tokens: int
    output_tokens: int
    elapsed_seconds: float
    # What the model sent back, as plain dicts: thinking, text and tool_use
    # blocks. The panel shows thinking summaries from here.
    response: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ToolRequested:
    tool_use_id: str
    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class PolicyDecided:
    name: str
    allowed: bool
    reason: str


@dataclass
class ToolReturned:
    name: str
    is_error: bool
    text: str


@dataclass
class FinalAnswer:
    text: str
    # "end_turn" is the normal case. "max_tokens", "call_limit" or a raw
    # stop_reason tell the renderer the answer may be incomplete.
    reason: str


@dataclass
class TurnStarted:
    """Emitted by the web app when a traveller message starts a turn."""

    text: str
    # A note from command expansion, e.g. which prompt produced the text.
    note: str = ""


@dataclass
class TurnFailed:
    """The turn ended with an exception (API error, timeout). History was
    rolled back; the panel shows a red row instead of a blank."""

    error: str


@dataclass
class SimulatedReply:
    """FooledLLM replaced the model's reply with a synthetic tool request.
    tool is None when the simulation was armed but found no injection to
    obey, so nothing was replaced."""

    tool: str | None
    args: dict[str, Any]
    note: str


@dataclass
class Reset:
    """The conversation and per-turn events were cleared; startup stays."""

    fooled: bool


# ---- wire --------------------------------------------------------------------


@dataclass
class WireMessage:
    """One raw JSON-RPC message, copied off the transport by wire_tap."""

    server: str
    direction: str  # "->" host to server, "<-" server to host
    method: str  # request method, or "response"/"error" for replies
    json: str


StartupEvent = Union[ConfigLoaded, ServerConnected, Handshake, ToolsDiscovered, MenuBuilt]
TurnEvent = Union[
    TurnStarted, ModelCalled, ToolRequested, PolicyDecided, ToolReturned, FinalAnswer, TurnFailed, SimulatedReply
]
Event = Union[StartupEvent, TurnEvent, WireMessage, Reset]
OnEvent = Callable[[Event], None]
