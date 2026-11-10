"""Events -> JSON -> Server-Sent Events frames.

Every string goes through redact() on the way out. Phase 4 has one rule:
anything shaped like an Anthropic API key. Phase 5 adds its tokens to the
same list. No module here ever reads the real key.
"""

from __future__ import annotations

import dataclasses
import json
import re
from typing import Any

from web.event_log import Entry

# (pattern, replacement). Keys look like sk-ant-api03-... with base64-ish characters.
REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"), "[REDACTED api key]"),
]


def redact(value: Any) -> Any:
    if isinstance(value, str):
        for pattern, replacement in REDACTIONS:
            value = pattern.sub(replacement, value)
        return value
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def to_dict(entry: Entry) -> dict[str, Any]:
    data = dataclasses.asdict(entry.event)
    data["type"] = type(entry.event).__name__
    data["seq"] = entry.seq
    return redact(data)


def sse_frame(entry: Entry) -> str:
    """id, event name, one-line JSON data, blank line. json.dumps escapes
    newlines inside strings, so `data:` is always a single line."""
    data = json.dumps(to_dict(entry), ensure_ascii=False)
    return f"id: {entry.seq}\nevent: {type(entry.event).__name__}\ndata: {data}\n\n"


KEEPALIVE = ": keepalive\n\n"
