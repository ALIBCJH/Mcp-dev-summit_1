"""Host-side MCP plumbing: one config type, one client type, one Host.

The host never knows what a server does. It only knows WHERE each server is
(ServerConfig), how to talk to one of them (MCPServerClient), and how to
present all of them as a single menu (Host). The Host also narrates its own
startup as events, so the trace begins before the first user message.
"""

from __future__ import annotations

import contextlib
import sys
from dataclasses import dataclass, field
from typing import Any

from mcp import Client, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from host import policy
from host.events import (
    BlockedTool,
    ConfigLoaded,
    Handshake,
    MenuBuilt,
    OnEvent,
    ServerConnected,
    ServerSummary,
    StartupEvent,
    ToolsDiscovered,
    WireMessage,
)
from host.tool_menu import ToolMenu, build_menu, to_anthropic_tool
from host.wire_tap import OnWire, tapped


class ServerUnavailable(RuntimeError):
    """A configured server could not be reached. Message is one readable line."""


@dataclass
class ServerConfig:
    """One entry from servers.json.

    Either command/args (stdio: we launch the process) or url (HTTP: it is
    already running somewhere). Nothing here describes the server's tools;
    those are discovered at runtime, so adding a tool to a server never
    requires a host change.
    """

    name: str
    command: str | None = None
    args: list[str] = field(default_factory=list)
    url: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ServerConfig":
        cfg = cls(
            name=raw["name"],
            command=raw.get("command"),
            args=list(raw.get("args", [])),
            url=raw.get("url"),
        )
        if bool(cfg.command) == bool(cfg.url):
            raise ValueError(f"server {cfg.name!r}: give exactly one of 'command' or 'url'")
        return cfg

    @property
    def kind(self) -> str:
        return "http" if self.url else "stdio"

    @property
    def where(self) -> str:
        if self.url:
            return self.url
        return " ".join([self.command or "", *self.args]).strip()

    def transport(self) -> Any:
        """The SDK transport for this server: a process (stdio) or a URL (HTTP)."""
        if self.url:
            return streamable_http_client(self.url)
        command = self.command
        # "python" in servers.json means "the Python running this host", not
        # whatever `python` resolves to on PATH. Otherwise the child may start
        # outside our virtualenv and fail with "No module named mcp".
        if command == "python":
            command = sys.executable
        return stdio_client(StdioServerParameters(command=command, args=self.args))


class MCPServerClient:
    """A connection to ONE MCP server.

    The same class serves every server, stdio or HTTP; only the transport
    differs. With an on_wire callback the transport is wrapped by wire_tap so
    every JSON-RPC message is copied to the trace.
    """

    def __init__(self, config: ServerConfig, on_wire: OnWire | None = None) -> None:
        self.config = config
        self.name = config.name
        self.on_wire = on_wire
        self._client: Client | None = None

    async def __aenter__(self) -> "MCPServerClient":
        transport = self.config.transport()
        if self.on_wire is not None:
            transport = tapped(transport, self.name, self.on_wire)
        client = Client(transport)
        try:
            await client.__aenter__()
        except Exception as exc:
            # Connection failures arrive wrapped in ExceptionGroups from the
            # async stack. A workshop audience needs one line, not a page.
            raise ServerUnavailable(self._unavailable_message()) from exc
        self._client = client
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._client is not None:
            await self._client.__aexit__(*exc_info)
            self._client = None

    def _unavailable_message(self) -> str:
        if self.config.url:
            return (
                f"server {self.name!r} is not reachable at {self.config.url}. "
                f"Start it in another terminal: python servers/{self.name}_server.py"
            )
        return f"server {self.name!r} failed to start: {self.config.where}"

    @property
    def client(self) -> Client:
        if self._client is None:
            raise RuntimeError(f"client {self.name!r} used outside 'async with'")
        return self._client

    # What the handshake told us. On this SDK the client sends server/discover
    # (no initialize request) and adopts the answer.
    @property
    def protocol_version(self) -> str:
        return str(self.client.protocol_version or "")

    @property
    def server_name(self) -> str:
        info = self.client.server_info
        return info.name if info is not None else ""

    @property
    def capabilities(self) -> list[str]:
        caps = self.client.server_capabilities
        if caps is None:
            return []
        return sorted(k for k, v in caps.model_dump(exclude_none=True).items() if v)

    # Every list_* call below follows the cursor until the server stops
    # returning one. Stopping after the first page would silently hide items.

    async def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            result = await self.client.list_tools(cursor=cursor)
            for tool in result.tools:
                tools.append(
                    {
                        "server": self.name,
                        "name": tool.name,
                        "description": tool.description or "",
                        "input_schema": tool.input_schema,
                    }
                )
            cursor = result.next_cursor
            if not cursor:
                return tools

    async def list_resources(self) -> list[dict[str, Any]]:
        resources: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            result = await self.client.list_resources(cursor=cursor)
            for res in result.resources:
                resources.append(
                    {
                        "server": self.name,
                        "uri": str(res.uri),
                        "name": res.name,
                        "description": res.description or "",
                        "mime_type": res.mime_type,
                    }
                )
            cursor = result.next_cursor
            if not cursor:
                return resources

    async def list_prompts(self) -> list[dict[str, Any]]:
        prompts: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            result = await self.client.list_prompts(cursor=cursor)
            for prompt in result.prompts:
                prompts.append(
                    {
                        "server": self.name,
                        "name": prompt.name,
                        "description": prompt.description or "",
                        "arguments": [
                            {"name": a.name, "description": a.description or "", "required": bool(a.required)}
                            for a in (prompt.arguments or [])
                        ],
                    }
                )
            cursor = result.next_cursor
            if not cursor:
                return prompts

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Call one tool and flatten the result to {"is_error", "text"}.

        is_error is surfaced as-is: the LLM needs to see the error message to
        correct its next call.
        """
        result = await self.client.call_tool(name, args)
        parts = [block.text for block in result.content if getattr(block, "text", None)]
        return {"is_error": bool(result.is_error), "text": "\n".join(parts)}

    async def read_resource(self, uri: str) -> str:
        result = await self.client.read_resource(uri)
        return "\n".join(c.text for c in result.contents if getattr(c, "text", None))

    async def get_prompt(self, name: str, args: dict[str, str]) -> str:
        """Render a prompt template. Arguments are strings on the wire; the
        server coerces them (e.g. days="3" -> int)."""
        result = await self.client.get_prompt(name, args)
        lines = []
        for msg in result.messages:
            text = getattr(msg.content, "text", None) or str(msg.content)
            lines.append(f"{msg.role}: {text}")
        return "\n".join(lines)


class Host:
    """Opens every configured server and presents them as one menu.

    Use as `async with Host(configs, on_event=fn) as host:`. All connections
    are opened inside one AsyncExitStack so that if the third server fails
    to start, the first two are still closed cleanly.

    Startup emits, in order: ConfigLoaded, then per server ServerConnected
    and Handshake, then per server ToolsDiscovered, then MenuBuilt. Each is
    also kept in `startup_events` so a listener that arrives later (the
    Phase 4 web page) can replay them.
    """

    def __init__(self, configs: list[ServerConfig], on_event: OnEvent | None = None) -> None:
        self.configs = configs
        self.on_event: OnEvent = on_event or (lambda event: None)
        self.clients: dict[str, MCPServerClient] = {}
        self.tools: list[dict[str, Any]] = []  # every discovered tool
        self.resources: list[dict[str, Any]] = []
        self.prompts: list[dict[str, Any]] = []
        self.menu: ToolMenu = ToolMenu()  # offered tools only, Anthropic-shaped
        self.startup_events: list[StartupEvent] = []
        self._tool_routes: dict[str, MCPServerClient] = {}
        self._stack: contextlib.AsyncExitStack | None = None

    def _emit(self, event: StartupEvent) -> None:
        self.startup_events.append(event)
        self.on_event(event)

    def _on_wire(self, server: str, direction: str, method: str, json_text: str) -> None:
        self.on_event(WireMessage(server=server, direction=direction, method=method, json=json_text))

    async def __aenter__(self) -> "Host":
        self._stack = contextlib.AsyncExitStack()
        await self._stack.__aenter__()
        try:
            self._emit(ConfigLoaded(servers=[ServerSummary(c.name, c.kind, c.where) for c in self.configs]))
            for cfg in self.configs:
                client = await self._stack.enter_async_context(MCPServerClient(cfg, on_wire=self._on_wire))
                self.clients[cfg.name] = client
                self._emit(ServerConnected(server=cfg.name, kind=cfg.kind, where=cfg.where))
                self._emit(
                    Handshake(
                        server=cfg.name,
                        protocol_version=client.protocol_version,
                        server_name=client.server_name,
                        capabilities=client.capabilities,
                        handshake="discover",
                    )
                )
            await self._discover_and_build_menu()
        except BaseException:
            # A failure half-way through must not leave processes running.
            await self._stack.aclose()
            raise
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._stack is not None:
            await self._stack.__aexit__(*exc_info)
            self._stack = None

    async def _discover_and_build_menu(self) -> None:
        for client in self.clients.values():
            tools = await client.list_tools()
            resources = await client.list_resources()
            prompts = await client.list_prompts()
            self.tools.extend(tools)
            self.resources.extend(resources)
            self.prompts.extend(prompts)
            self._emit(
                ToolsDiscovered(
                    server=client.name,
                    tool_names=[t["name"] for t in tools],
                    resource_uris=[r["uri"] for r in resources],
                    prompt_names=[p["name"] for p in prompts],
                )
            )
        # Tool names are the LLM's only handle on a tool. build_menu refuses
        # duplicates, so the host fails at startup rather than guessing later.
        full_menu = build_menu(self.tools)
        # The routing table knows every discovered tool. A blocked name that
        # somehow reaches run_tool is refused by policy.check, not a KeyError.
        self._tool_routes = {name: self.clients[server] for name, server in full_menu.owner.items()}
        # Policy gate one: Claude is only ever offered listed tools.
        offered, blocked = policy.filter_menu(self.tools)
        self.menu = ToolMenu(
            definitions=[to_anthropic_tool(t) for t in offered],
            owner={t["name"]: t["server"] for t in offered},
        )
        self._emit(
            MenuBuilt(
                offered=[t["name"] for t in offered],
                blocked=[BlockedTool(name, server, reason) for name, server, reason in blocked],
            )
        )

    async def run_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Send a tool call to whichever server owns that tool name."""
        try:
            client = self._tool_routes[name]
        except KeyError:
            return {"is_error": True, "text": f"unknown tool {name!r}"}
        return await client.call_tool(name, args)

    async def read_resource(self, server: str, uri: str) -> str:
        return await self.clients[server].read_resource(uri)

    async def get_prompt(self, server: str, name: str, args: dict[str, str]) -> str:
        return await self.clients[server].get_prompt(name, args)
