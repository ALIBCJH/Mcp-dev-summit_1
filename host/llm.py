"""The only module that imports the Anthropic SDK.

Two classes with the same `send` signature:
- ClaudeLLM talks to the real API.
- ScriptedLLM replays canned responses, so the agent loop can be tested
  without a key, without cost, and with full control over what the model
  "decides".
"""

from __future__ import annotations

import os
from typing import Any

import anthropic
from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

DEFAULT_MODEL = "claude-sonnet-5-5"
# Generous enough for any travel answer; the loop handles max_tokens anyway.
MAX_TOKENS = 16000

# Thinking settings come from .env. Unset means "send nothing", which is the
# model's own default (adaptive thinking, reasoning not shown). We never send
# type "disabled": Sonnet 5.5 rejects it with a 400.
THINKING_TYPES = ("adaptive", "between_tools")
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
DISPLAY_MODES = ("omitted", "summarized")


def _env_choice(name: str, allowed: tuple[str, ...]) -> str | None:
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return None
    if value not in allowed:
        raise ValueError(f"{name}={value!r}; expected one of {', '.join(allowed)}")
    return value


class ClaudeLLM:
    def __init__(self, model: str | None = None) -> None:
        # AsyncAnthropic() reads ANTHROPIC_API_KEY from the environment. The
        # key is never passed through our code, so it cannot leak into a
        # trace or a log line.
        self.client = anthropic.AsyncAnthropic()
        self.model = model or os.environ.get("ANTHROPIC_MODEL") or DEFAULT_MODEL
        self.thinking = _env_choice("ANTHROPIC_THINKING", THINKING_TYPES)
        self.effort = _env_choice("ANTHROPIC_EFFORT", EFFORT_LEVELS)
        self.display = _env_choice("ANTHROPIC_THINKING_DISPLAY", DISPLAY_MODES)
        if self.thinking == "between_tools" and self.display:
            raise ValueError("ANTHROPIC_THINKING_DISPLAY cannot be combined with between_tools")

    def settings(self) -> str:
        """One line for the startup banner."""
        return (
            f"thinking={self.thinking or 'default'} effort={self.effort or 'default'} "
            f"display={self.display or 'default'} max_tokens={MAX_TOKENS}"
        )

    def _extra(self) -> dict[str, Any]:
        extra: dict[str, Any] = {}
        if self.thinking == "adaptive":
            extra["thinking"] = {"type": "adaptive", **({"display": self.display} if self.display else {})}
        elif self.thinking == "between_tools":
            # between_tools takes no other field; display and budget are 400s.
            extra["thinking"] = {"type": "between_tools"}
        if self.effort:
            extra["output_config"] = {"effort": self.effort}
        return extra

    async def send(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Message:
        # tool_choice stays at its default ("auto"): Sonnet 5.5 rejects forced
        # tool use, and we want the model to decide anyway.
        return await self.client.messages.create(
            model=self.model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
            tools=tools,
            **self._extra(),
        )


class ScriptedLLM:
    """Replays a list of responses in order. Each response is a dict:

        {"text": "..."}                                   -> end_turn
        {"tool": "name", "args": {...}}                    -> one tool_use
        {"tools": [("name", {...}), ...]}                  -> several tool_use
        {"text": "...", "stop_reason": "max_tokens"}       -> any stop reason

    The responses are built as real SDK Message objects so the agent loop
    runs the exact code it runs against Claude.
    """

    model = "scripted"

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []  # what the loop sent, for assertions

    async def send(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Message:
        self.calls.append({"system": system, "messages": list(messages), "tools": tools})
        if not self.responses:
            raise RuntimeError("ScriptedLLM has no responses left")
        spec = self.responses.pop(0)

        content: list[Any] = []
        if "text" in spec:
            content.append(TextBlock(type="text", text=spec["text"]))
        tool_calls = spec.get("tools") or ([(spec["tool"], spec.get("args", {}))] if "tool" in spec else [])
        for i, (name, args) in enumerate(tool_calls):
            content.append(ToolUseBlock(type="tool_use", id=f"toolu_scripted_{len(self.calls)}_{i}", name=name, input=args))

        stop_reason = spec.get("stop_reason") or ("tool_use" if tool_calls else "end_turn")
        return Message(
            id=f"msg_scripted_{len(self.calls)}",
            type="message",
            role="assistant",
            model=self.model,
            content=content,
            stop_reason=stop_reason,
            stop_sequence=None,
            usage=Usage(input_tokens=0, output_tokens=0),
        )
