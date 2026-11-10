"""Shared data loader for the demo servers.

Each server reads one JSON file from servers/data/ exactly once, at import
time. Keeping the path logic here means every server finds its data no
matter which directory the host was started from.
"""

import json
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"


def load(filename: str) -> list[dict[str, Any]]:
    # Note for hotels.json: one review is intentionally poisoned for the
    # Phase 5 injection demo. This loader must return it untouched.
    with open(DATA_DIR / filename, encoding="utf-8") as f:
        return json.load(f)
