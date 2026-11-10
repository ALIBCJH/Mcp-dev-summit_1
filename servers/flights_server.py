"""Flights server (stdio): search a route, check a flight, read the baggage policy.

Logs go to stderr because stdout is the MCP wire.
"""

import logging
import sys
from pathlib import Path

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

# Run as a plain script by the host, so make the sibling _data module importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _data import load  # noqa: E402

logging.basicConfig(
    level=logging.INFO, stream=sys.stderr, format="[flights] %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

# Loaded once. A real server would query an inventory system here.
FLIGHTS = load("flights.json")
BY_NUMBER = {f["flight"]: f for f in FLIGHTS}

mcp = MCPServer("flights")


def _check_code(label: str, code: str) -> str:
    # The LLM sometimes passes city names ("Diani") where a code is needed.
    # A precise error lets it correct itself on the next call.
    code = code.strip().upper()
    if len(code) != 3 or not code.isalpha():
        raise ToolError(
            f"{label} must be a 3-letter IATA airport code such as NBO or UKA, got {code!r}."
        )
    return code


@mcp.tool()
def search_flights(origin: str, destination: str) -> list[dict]:
    """Find flights on a route within Kenya.

    Use this to list available flights between two airports. `origin` and
    `destination` are 3-letter IATA airport codes: NBO (Nairobi), UKA (Diani
    Beach), LAU (Lamu), MYD (Malindi/Watamu), NYK (Nanyuki), KIS (Kisumu),
    MRE (Maasai Mara). Returns each flight's number, price in KES and status.
    """
    origin = _check_code("origin", origin)
    destination = _check_code("destination", destination)
    matches = [f for f in FLIGHTS if f["origin"] == origin and f["destination"] == destination]
    log.info("search %s->%s: %d result(s)", origin, destination, len(matches))
    if not matches:
        raise ToolError(f"No flights found from {origin} to {destination}.")
    return matches


@mcp.tool()
def get_flight_status(flight: str) -> str:
    """Get the current status of one flight.

    `flight` is a flight number such as KF101. Returns "on time",
    "delayed" or "cancelled".
    """
    key = flight.strip().upper()
    if key not in BY_NUMBER:
        raise ToolError(f"Unknown flight {flight!r}. Use search_flights to find valid flight numbers.")
    return BY_NUMBER[key]["status"]


@mcp.resource(
    "flights://policy/baggage",
    name="baggage_policy",
    description="Baggage allowance and fees for all flights.",
    mime_type="text/plain",
)
def baggage_policy() -> str:
    # A resource is read by the host or shown to a person; it is not a tool
    # the model calls. Later phases will decide whether to feed it to Claude.
    return (
        "Baggage policy\n"
        "- Cabin: one bag up to 7 kg, max 55x40x20 cm.\n"
        "- Checked: one bag up to 15 kg included on all fares. Small aircraft, soft bags please.\n"
        "- Extra checked bag: KES 2,500 each way, booked before departure.\n"
        "- Sports equipment (kitesurf, dive gear): KES 3,500 each way, must be declared at booking.\n"
    )


if __name__ == "__main__":
    mcp.run()
