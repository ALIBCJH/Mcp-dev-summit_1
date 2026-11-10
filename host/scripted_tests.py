"""Checks on the host brain that need no API key.

    python host/scripted_tests.py

(a) a disallowed tool is denied at call time and the turn continues
(b) a model that always asks for tools stops at MAX_MODEL_CALLS
(c) duplicate tool names fail at startup
(d) the menu filter blocks an unlisted tool with its reason
(e) a bad airport code through the REAL flights server arrives as is_error

(a)-(d) use a FakeHost. (e) launches the real flights server over stdio.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host import policy  # noqa: E402
from host.agent import MAX_MODEL_CALLS, Conversation, run_turn  # noqa: E402
from host.events import FinalAnswer, ModelCalled, PolicyDecided, ToolReturned  # noqa: E402
from host.llm import ScriptedLLM  # noqa: E402
from host.mcp_clients import Host, ServerConfig  # noqa: E402
from host.tool_menu import DuplicateToolError, build_menu  # noqa: E402


class FakeHost:
    """Stands in for the MCP Host: answers every tool call with canned text."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def run_tool(self, name: str, args: dict) -> dict:
        self.calls.append((name, args))
        return {"is_error": False, "text": f"fake result for {name}"}


TOOLS = [{"name": "search_flights", "description": "x", "input_schema": {"type": "object"}}]


async def test_a_denied_tool_continues() -> None:
    llm = ScriptedLLM([
        {"tool": "delete_everything", "args": {"really": True}},
        {"text": "I could not do that, but here is what I can do."},
    ])
    host, events = FakeHost(), []
    answer = await run_turn(Conversation(), "wipe it", llm, host, TOOLS, "sys", events.append)

    decisions = [e for e in events if isinstance(e, PolicyDecided)]
    assert decisions and not decisions[0].allowed, "expected a denial"
    assert not host.calls, "denied tool must never reach the host"
    assert not any(isinstance(e, ToolReturned) for e in events), "nothing ran, so nothing returned"
    sent = llm.calls[1]["messages"][-1]  # what the model saw on its second call
    assert sent["role"] == "user" and sent["content"][0]["is_error"] is True
    assert policy.NOT_LISTED in sent["content"][0]["content"]
    assert isinstance(events[-1], FinalAnswer) and events[-1].reason == "end_turn"
    assert answer.startswith("I could not")
    print("PASS (a) disallowed tool denied at call time; turn continued to a final answer")


async def test_b_call_limit() -> None:
    llm = ScriptedLLM([{"tool": "search_flights", "args": {"origin": "NBO", "destination": "UKA"}}] * 20)
    host, events = FakeHost(), []
    answer = await run_turn(Conversation(), "loop forever", llm, host, TOOLS, "sys", events.append)

    model_calls = [e for e in events if isinstance(e, ModelCalled)]
    assert len(model_calls) == MAX_MODEL_CALLS, f"expected {MAX_MODEL_CALLS} calls, got {len(model_calls)}"
    assert len(host.calls) == MAX_MODEL_CALLS
    assert isinstance(events[-1], FinalAnswer) and events[-1].reason == "call_limit"
    assert "stopped after 8" in answer
    print(f"PASS (b) stopped after {MAX_MODEL_CALLS} model calls with reason=call_limit")


def test_c_duplicate_names() -> None:
    tools = [
        {"server": "flights", "name": "search", "description": "a", "input_schema": {}},
        {"server": "hotels", "name": "search", "description": "b", "input_schema": {}},
    ]
    try:
        build_menu(tools)
    except DuplicateToolError as exc:
        assert "flights" in str(exc) and "hotels" in str(exc)
        print(f"PASS (c) duplicate tool names rejected: {exc}")
        return
    raise AssertionError("expected DuplicateToolError")


def test_d_menu_filter() -> None:
    tools = [{"server": "x", "name": n, "description": "", "input_schema": {}} for n in policy.ALLOWED]
    tools.append({"server": "evil", "name": "wipe_disk", "description": "", "input_schema": {}})
    offered, blocked = policy.filter_menu(tools)
    assert [t["name"] for t in offered] == list(policy.ALLOWED)
    assert blocked == [("wipe_disk", "evil", policy.NOT_LISTED)]
    print(f"PASS (d) menu filter offered {len(offered)}, blocked wipe_disk [evil: {policy.NOT_LISTED}]")


async def test_e_bad_airport_code_real_server() -> None:
    llm = ScriptedLLM([
        {"tool": "search_flights", "args": {"origin": "DIANI", "destination": "NBO"}},
        {"text": "That code was wrong; let me try UKA."},
    ])
    cfg = ServerConfig(name="flights", command="python", args=["servers/flights_server.py"])
    events = []
    async with Host([cfg]) as host:
        await run_turn(Conversation(), "fly me", llm, host, host.menu.definitions, "sys", events.append)

    returned = [e for e in events if isinstance(e, ToolReturned)]
    assert len(returned) == 1 and returned[0].is_error, "expected one is_error ToolReturned"
    assert "3-letter IATA airport code" in returned[0].text and "'DIANI'" in returned[0].text
    sent = llm.calls[1]["messages"][-1]["content"][0]  # the tool_result Claude would read
    assert sent["type"] == "tool_result" and sent["is_error"] is True
    assert sent["content"] == returned[0].text
    print(f"PASS (e) real flights server ToolError reached the model as is_error: {sent['content']}")


async def main() -> None:
    await test_a_denied_tool_continues()
    await test_b_call_limit()
    test_c_duplicate_names()
    test_d_menu_filter()
    await test_e_bad_airport_code_real_server()
    print("\nall scripted tests passed")


if __name__ == "__main__":
    asyncio.run(main())
