"""Turn the merged MCP tool list into what the Anthropic API expects.

An MCP tool and an Anthropic tool definition carry the same three things
(name, description, JSON schema for the input), so conversion is a rename.
The important job here is the duplicate check: the model addresses tools by
name alone, so two servers offering the same name would be unroutable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class DuplicateToolError(RuntimeError):
    """Two servers offer a tool with the same name."""


@dataclass
class ToolMenu:
    definitions: list[dict[str, Any]] = field(default_factory=list)  # sent to Claude
    owner: dict[str, str] = field(default_factory=dict)  # tool name -> server name


def to_anthropic_tool(mcp_tool: dict[str, Any]) -> dict[str, Any]:
    """One MCP tool dict (as MCPServerClient.list_tools returns) -> API shape."""
    return {
        "name": mcp_tool["name"],
        "description": mcp_tool["description"],
        "input_schema": mcp_tool["input_schema"],
    }


def build_menu(mcp_tools: list[dict[str, Any]]) -> ToolMenu:
    """Build the menu for Claude and the routing table. Fails on duplicates."""
    menu = ToolMenu()
    for tool in mcp_tools:
        name = tool["name"]
        if name in menu.owner:
            raise DuplicateToolError(
                f"tool name clash: '{name}' is offered by both "
                f"'{menu.owner[name]}' and '{tool['server']}'. Rename one of them."
            )
        menu.owner[name] = tool["server"]
        menu.definitions.append(to_anthropic_tool(tool))
    return menu
