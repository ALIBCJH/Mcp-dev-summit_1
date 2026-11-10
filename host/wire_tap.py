"""A pass-through MCP transport that copies every JSON-RPC message to a callback.

The MCP Client accepts any async context manager that yields a (read, write)
pair of SessionMessage streams. We enter the real transport (stdio or HTTP),
hand the client two relay streams, and run two pump tasks that copy each
message to `on_wire` and forward it unchanged. The client cannot tell the
tap is there, which is the point: the trace shows the real wire, not a
reconstruction.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

import anyio

OnWire = Callable[[str, str, str, str], None]  # (server, direction, method, json)


def _method_of(payload: dict[str, Any]) -> str:
    if "method" in payload:
        return payload["method"]
    return "error" if "error" in payload else "response"


@asynccontextmanager
async def tapped(inner: Any, server: str, on_wire: OnWire) -> AsyncIterator[tuple[Any, Any]]:
    async with inner as (read, write):
        # Relay streams. Buffer 0 means each message is handed over
        # synchronously, so ordering in the trace matches the wire.
        relay_in_send, relay_in_recv = anyio.create_memory_object_stream(0)
        relay_out_send, relay_out_recv = anyio.create_memory_object_stream(0)

        def report(direction: str, msg: Any) -> None:
            text = msg.message.model_dump_json(by_alias=True, exclude_none=True)
            on_wire(server, direction, _method_of(json.loads(text)), text)

        async def pump_in() -> None:  # server -> host
            try:
                async with relay_in_send:
                    while True:
                        msg = await read.receive()
                        if not isinstance(msg, Exception):
                            report("<-", msg)
                        await relay_in_send.send(msg)
            except (anyio.EndOfStream, anyio.ClosedResourceError, anyio.BrokenResourceError):
                pass  # the server closed, or the client stopped reading: normal shutdown

        async def pump_out() -> None:  # host -> server
            try:
                async with relay_out_recv:
                    async for msg in relay_out_recv:
                        report("->", msg)
                        await write.send(msg)
            except (anyio.ClosedResourceError, anyio.BrokenResourceError):
                pass

        async with anyio.create_task_group() as tg:
            tg.start_soon(pump_in)
            tg.start_soon(pump_out)
            try:
                yield relay_in_recv, relay_out_send
            finally:
                # Close our side first so the pumps finish, then cancel
                # whatever is still blocked (pump_in waiting on a quiet server).
                await relay_out_send.aclose()
                await relay_in_recv.aclose()
                tg.cancel_scope.cancel()
