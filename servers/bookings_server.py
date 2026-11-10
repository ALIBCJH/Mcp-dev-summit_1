"""Bookings server (Streamable HTTP): book a flight+hotel combination, cancel it.

Runs as a standalone web service on PORT (default 9000), reachable at
http://127.0.0.1:9000/mcp. Phase 5 adds a token check and a confirmation
step; this phase is the plain tools only.
"""

import logging
import os
import sys
import uuid
from pathlib import Path

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _data import load  # noqa: E402

logging.basicConfig(
    level=logging.INFO, stream=sys.stderr, format="[bookings] %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

# A code rule, not data: no prompt can change it. 10 nights in the KES 120,000
# suite (the Phase 5 injection) comes to 1,200,000 and is refused here.
MAX_BOOKING_KES = 150_000

# In real life Bookings would ask the Flights and Hotels systems for prices.
# Here it reads the same data files, which keeps the demo to three processes.
FLIGHTS = {f["flight"]: f for f in load("flights.json")}
HOTELS = {h["hotel_id"]: h for h in load("hotels.json")}

# Bookings live in memory and are lost on restart. Demo 2 (k3d, Redis) moves
# them to a real store so that several replicas see the same bookings.
BOOKINGS: dict[str, dict] = {}

mcp = MCPServer("bookings")


@mcp.tool()
def book_trip(flight: str, hotel_id: str, nights: int) -> dict:
    """Book a flight and hotel together.

    `flight` is a flight number from search_flights (e.g. KF101). `hotel_id`
    is a hotel id from search_hotels (e.g. DIA-GALU). `nights` is 1 to 14.
    The server computes the price itself from its own data. Returns a booking
    id and the total in KES.
    """
    # The caller never supplies a price. If it could, a fooled LLM could pass
    # a fake low price to slip under MAX_BOOKING_KES.
    flight_key = flight.strip().upper()
    hotel_key = hotel_id.strip().upper()
    if flight_key not in FLIGHTS:
        raise ToolError(f"Unknown flight {flight!r}.")
    if hotel_key not in HOTELS:
        raise ToolError(f"Unknown hotel_id {hotel_id!r}.")
    if not 1 <= nights <= 14:
        raise ToolError(f"nights must be between 1 and 14, got {nights}.")
    if FLIGHTS[flight_key]["status"] == "cancelled":
        raise ToolError(f"Flight {flight_key} is cancelled and cannot be booked.")

    hotel = HOTELS[hotel_key]
    total = FLIGHTS[flight_key]["price_kes"] + hotel["price_per_night_kes"] * nights
    if total > MAX_BOOKING_KES:
        raise ToolError(
            f"Total KES {total:,} exceeds the booking limit of KES {MAX_BOOKING_KES:,}. "
            "Choose a cheaper hotel or fewer nights."
        )

    booking_id = f"BK-{uuid.uuid4().hex[:8].upper()}"
    BOOKINGS[booking_id] = {
        "booking_id": booking_id,
        "flight": flight_key,
        "hotel_id": hotel_key,
        "hotel": hotel["name"],
        "nights": nights,
        "total_kes": total,
        "status": "confirmed",
    }
    log.info("booked %s: %s + %s x%d = KES %d", booking_id, flight_key, hotel_key, nights, total)
    return BOOKINGS[booking_id]


@mcp.tool()
def cancel_booking(booking_id: str) -> dict:
    """Cancel an existing booking by its id (e.g. BK-1A2B3C4D)."""
    key = booking_id.strip().upper()
    if key not in BOOKINGS:
        raise ToolError(f"Unknown booking_id {booking_id!r}.")
    booking = BOOKINGS.pop(key)
    booking["status"] = "cancelled"
    log.info("cancelled %s", key)
    return booking


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9000"))
    log.info("listening on http://127.0.0.1:%d/mcp", port)
    # stateless_http=True: no session ids, so any replica can serve any
    # request. That is what Demo 2 (k3d) needs.
    mcp.run("streamable-http", host="127.0.0.1", port=port, streamable_http_path="/mcp", stateless_http=True)
