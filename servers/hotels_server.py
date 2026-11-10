"""Hotels server (stdio): search hotels, a Kenya guide resource, a plan-trip prompt.

Logs go to stderr because stdout is the MCP wire.
"""

import logging
import sys
from pathlib import Path

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _data import load  # noqa: E402

logging.basicConfig(
    level=logging.INFO, stream=sys.stderr, format="[hotels] %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

HOTELS = load("hotels.json")

mcp = MCPServer("hotels")


def _check_nights(label: str, value: int) -> int:
    if not 1 <= value <= 14:
        raise ToolError(f"{label} must be between 1 and 14, got {value}.")
    return value


@mcp.tool()
def search_hotels(city: str, nights: int) -> list[dict]:
    """Find hotels in a Kenyan destination and price a stay.

    `city` is a destination name such as Diani Beach, Lamu, Watamu, Malindi,
    Nanyuki, Kisumu or Maasai Mara. `nights` is the length of the stay, 1 to
    14. Returns each hotel's id, name, nightly and total price in KES, rating
    and guest reviews.
    """
    nights = _check_nights("nights", nights)
    wanted = city.strip().lower()
    matches = [h for h in HOTELS if h["city"].lower() == wanted]
    log.info("search %s x%d nights: %d result(s)", city, nights, len(matches))
    if not matches:
        raise ToolError(f"No hotels found in {city!r}.")
    # Reviews are returned exactly as stored. This server is a data source,
    # not a filter; deciding what to trust is the host's job (Phase 5).
    return [
        {
            "hotel_id": h["hotel_id"],
            "name": h["name"],
            "city": h["city"],
            "price_per_night_kes": h["price_per_night_kes"],
            "total_kes": h["price_per_night_kes"] * nights,
            "nights": nights,
            "rating": h["rating"],
            "reviews": h["reviews"],
        }
        for h in matches
    ]


KENYA_GUIDE = """Where to go in Kenya

Diani Beach (fly to UKA)
  Seventeen kilometres of white sand about thirty kilometres south of
  Mombasa, a reef you can swim out to, and colobus monkeys in the trees
  above the road. Kitesurf in the morning, take a dhow out at sunset. Best
  from December to March and July to October; the long rains come in April
  and May.

Lamu (fly to LAU)
  A Swahili old town with no cars, where donkeys carry the luggage and dhows
  carry everything else. Carved doors, rooftop dinners, and the slowest pace
  on the coast. Best from November to March. The cultural festival is
  usually in November.

Malindi and Watamu (fly to MYD)
  Watamu's marine park is the place to snorkel with turtles; Malindi has the
  Gede ruins and Italian espresso. Best from October to March, when the
  water is clearest.

Nanyuki (fly to NYK)
  Straddles the equator at the foot of Mount Kenya. Ol Pejeta Conservancy is
  next door, home to the world's last northern white rhinos. Cool nights,
  clear mornings. Best in January and February and from July to October.

Kisumu (fly to KIS)
  Lake Victoria sunsets from the Dunga boardwalk, fresh tilapia on the shore,
  and the balancing rocks at Kit Mikayi an hour away. Pleasant all year;
  driest from December to February.

Maasai Mara (fly to MRE)
  Big cats all year and the wildebeest migration from July to October, when
  the river crossings happen. Hot-air balloon at dawn if you can. Best from
  July to October; January and February are quieter and green.
"""


@mcp.resource(
    "hotels://guide/kenya",
    name="kenya_guide",
    description="Where to go in Kenya: what makes each destination special and the best time to visit.",
    mime_type="text/plain",
)
def kenya_guide() -> str:
    return KENYA_GUIDE


@mcp.prompt(name="plan-trip", description="Plan a trip from Nairobi: flights, hotel and a total price.")
def plan_trip(destination: str, days: int) -> str:
    """Template the person picks to plan a trip from Nairobi."""
    # Prompts are chosen by the PERSON, not the model. The host will later
    # turn this text into the first user message of a conversation.
    days = _check_nights("days", days)
    return (
        f"Plan a {days}-day trip from Nairobi (NBO) to {destination}.\n"
        f"1. Search flights from NBO to the airport serving {destination}.\n"
        f"2. Search hotels in {destination} for {days} nights.\n"
        "3. Propose ONE flight plus ONE hotel combination and state the total price in KES.\n"
        "Do not book anything without asking me first."
    )


if __name__ == "__main__":
    mcp.run()
