"""The agent loop: user text in, final answer out, tools in between.

One turn = up to MAX_MODEL_CALLS requests to the model. Claude's API is
stateless, so every request carries the system prompt, the menu (built once
at startup) and the full message list, which the host owns. Each response
may ask for tools; every tool_use block is checked against policy, run
through the MCP host, and ALL results go back in ONE user message.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from host import policy
from host.events import FinalAnswer, ModelCalled, OnEvent, PolicyDecided, ToolRequested, ToolReturned

MAX_MODEL_CALLS = 8


@dataclass
class Conversation:
    """The message history, in memory, in the exact shape the API wants."""

    messages: list[dict[str, Any]] = field(default_factory=list)
    # Resources the person attached with /attach. They ride along at the
    # front of the next user message, so the trace shows when Claude saw them.
    pending_attachments: list[tuple[str, str]] = field(default_factory=list)

    def attach(self, label: str, text: str) -> None:
        self.pending_attachments.append((label, text))

    def add_user_text(self, text: str) -> None:
        blocks: list[dict[str, Any]] = [
            {"type": "text", "text": f"Attached resource {label}:\n{body}"}
            for label, body in self.pending_attachments
        ]
        self.pending_attachments.clear()
        blocks.append({"type": "text", "text": text})
        self.messages.append({"role": "user", "content": blocks})


def _text_of(content: list[Any]) -> str:
    return "\n".join(b.text for b in content if getattr(b, "type", None) == "text" and b.text)


def _plain(value: Any) -> Any:
    """SDK block objects -> plain dicts, for an event a web page can serialise."""
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


async def run_turn(
    conv: Conversation,
    user_text: str,
    llm: Any,
    host: Any,
    tools: list[dict[str, Any]],
    system: str,
    on_event: OnEvent,
) -> str:
    """Run one traveller turn to completion and return the final answer text."""
    conv.add_user_text(user_text)

    for call_number in range(1, MAX_MODEL_CALLS + 1):
        started = time.perf_counter()
        response = await llm.send(system, conv.messages, tools)
        on_event(
            ModelCalled(
                call_number=call_number,
                max_calls=MAX_MODEL_CALLS,
                model=getattr(llm, "model", ""),
                system=system,
                messages=_plain(conv.messages),
                tools=tools,
                stop_reason=response.stop_reason or "",
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                elapsed_seconds=round(time.perf_counter() - started, 2),
            )
        )
        # Append the whole content list, not just the text: thinking blocks
        # and tool_use blocks must round-trip unchanged.
        conv.messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "tool_use":
            results = []
            for block in response.content:
                if getattr(block, "type", None) != "tool_use":
                    continue
                results.append(await _handle_tool_use(block, host, on_event))
            # One user message carrying every result, in the order requested.
            conv.messages.append({"role": "user", "content": results})
            continue

        text = _text_of(response.content)
        if response.stop_reason == "end_turn":
            on_event(FinalAnswer(text=text, reason="end_turn"))
            return text
        if response.stop_reason == "max_tokens":
            text = text + "\n[answer cut off: the model hit its output limit]"
            on_event(FinalAnswer(text=text, reason="max_tokens"))
            return text
        # refusal, pause_turn, stop_sequence or something newer: say so
        # rather than pretend it was a normal answer.
        text = text or f"[the model stopped with reason '{response.stop_reason}']"
        on_event(FinalAnswer(text=text, reason=str(response.stop_reason)))
        return text

    text = f"[stopped after {MAX_MODEL_CALLS} model calls without a final answer]"
    on_event(FinalAnswer(text=text, reason="call_limit"))
    return text


async def _handle_tool_use(block: Any, host: Any, on_event: OnEvent) -> dict[str, Any]:
    """Policy check, then run. Always returns a tool_result; never raises."""
    args = dict(block.input or {})
    on_event(ToolRequested(tool_use_id=block.id, name=block.name, args=args))

    decision = policy.check(block.name, args)
    on_event(PolicyDecided(name=block.name, allowed=decision.allowed, reason=decision.reason))
    if not decision.allowed:
        # The model learns why, in plain words, and the turn carries on.
        return _tool_result(block.id, decision.reason, is_error=True)

    try:
        result = await host.run_tool(block.name, args)
    except Exception as exc:  # a server died mid-call; the turn must survive
        result = {"is_error": True, "text": f"Tool '{block.name}' failed to run: {exc}"}
    on_event(ToolReturned(name=block.name, is_error=result["is_error"], text=result["text"]))
    return _tool_result(block.id, result["text"], is_error=result["is_error"])


def _tool_result(tool_use_id: str, text: str, *, is_error: bool) -> dict[str, Any]:
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": text or "(no output)",
        "is_error": is_error,
    }
