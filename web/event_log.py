"""The event log behind the bonnet panel.

Every event gets a sequence number that only ever grows. Startup events are
kept for the life of the process; per-turn events are dropped on reset. A
subscriber gets the history after a given sequence number and then live
events, with no gap and no duplicate: the snapshot and the subscription are
taken under the same lock, and the page dedupes by seq as a second guard.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from host.events import Event, Reset


@dataclass(frozen=True)
class Entry:
    seq: int
    event: Event


class EventLog:
    def __init__(self) -> None:
        self._seq = 0
        self.startup: list[Entry] = []
        self.turn: list[Entry] = []
        self.startup_done = False
        self._subscribers: list[asyncio.Queue[Entry]] = []
        self._lock = asyncio.Lock()

    @property
    def last_seq(self) -> int:
        return self._seq

    def mark_startup_done(self) -> None:
        self.startup_done = True

    def append(self, event: Event) -> Entry:
        """Called from the Host and the agent loop, on the event loop thread."""
        self._seq += 1
        entry = Entry(self._seq, event)
        if isinstance(event, Reset):
            # Drop the turn events but keep the Reset itself, so a subscriber
            # that saw the old turn events learns to clear them.
            self.turn.clear()
        (self.turn if self.startup_done else self.startup).append(entry)
        for queue in self._subscribers:
            queue.put_nowait(entry)
        return entry

    def reset(self, fooled: bool) -> Entry:
        return self.append(Reset(fooled=fooled))

    def since(self, after: int) -> list[Entry]:
        return [e for e in self.startup + self.turn if e.seq > after]

    async def subscribe(self, after: int) -> tuple[list[Entry], asyncio.Queue[Entry]]:
        """History after `after`, and a queue that receives everything newer.
        Both under one lock, so nothing can slip between them."""
        async with self._lock:
            queue: asyncio.Queue[Entry] = asyncio.Queue()
            self._subscribers.append(queue)
            return self.since(after), queue

    def unsubscribe(self, queue: asyncio.Queue[Entry]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
