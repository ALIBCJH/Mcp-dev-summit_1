# Travel Assistant (MCP workshop demo)

A Kenya travel assistant. Phase 3: three MCP servers behind one host, with
Claude deciding which tools to call. No web app yet; that is Phase 4.

Destinations (real places, invented hotels and airlines): Diani Beach (UKA),
Lamu (LAU), Malindi/Watamu (MYD), Nanyuki (NYK), Kisumu (KIS), Maasai Mara
(MRE). Flights depart Nairobi (NBO). Prices are in KES.

## Layout

- `servers/` one process per server.
  - `flights_server.py` (stdio): `search_flights`, `get_flight_status`,
    resource `flights://policy/baggage`.
  - `hotels_server.py` (stdio): `search_hotels`, resource
    `hotels://guide/kenya`, prompt `plan-trip`.
  - `bookings_server.py` (Streamable HTTP on port 9000): `book_trip`,
    `cancel_booking`. Bookings are in memory and lost on restart.
  - `_data.py` loads a JSON file from `servers/data/` once at startup.
  - `data/` the JSON data and a README. One Diani Beach review is
    deliberately poisoned for the Phase 5 security demo; do not clean it.
- `host/` the host side. `mcp_clients.py` holds the plumbing (config, one
  client per server, a Host that merges them). `smoke_test.py` exercises it.
- `servers.json` tells the host where each server is, not what it does.
- `tools/` empty until later phases.

## Setup

Requires Python 3.11 or newer.

```bash
cd travel-assistant
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL)
```

`.env` is git-ignored. Never commit it.

## Smoke test (two terminals)

Terminal 1, the bookings server (set `PORT` to change the port):

```bash
source .venv/bin/activate
python servers/bookings_server.py
```

Terminal 2, from the project root because `servers.json` uses relative paths:

```bash
source .venv/bin/activate
python host/smoke_test.py
```

The stdio servers are started by the host itself. If bookings is not
running, the smoke test stops with a one-line message telling you how to
start it.

Expected: tools, resources and prompts from all three servers; flights
NBO to UKA; Diani Beach hotels for 2 nights with the poisoned review visible
on DIA-CORAL; both resources; the plan-trip prompt; a booking that succeeds
and is cancelled; and two `is_error=True` results with readable messages.

## Chat with Claude (Phase 3)

Put your key in `.env` (`ANTHROPIC_API_KEY=...`). Optional settings, all
defaulting to the model's own behaviour: `ANTHROPIC_MODEL` (default
`claude-sonnet-5-5`), `ANTHROPIC_THINKING` (`adaptive` or `between_tools`),
`ANTHROPIC_EFFORT` (`low` to `max`), `ANTHROPIC_THINKING_DISPLAY`
(`omitted` or `summarized`). With the bookings server running:

```bash
python host/chat.py          # add --wire to see every raw JSON-RPC message
```

Startup prints five lines: config, connected, handshake, discovered, menu.
Then type a request, or `/plan-trip Diani Beach 2` to start from the hotels
server's prompt, or `/attach flights://policy/baggage` to send a resource
with your next message. Every model call, tool request, policy decision and
tool result is printed as a trace line.

The host brain lives in `host/`: `llm.py` (the only file that imports the
Anthropic SDK), `tool_menu.py` (MCP tools -> API tool definitions, duplicate
check), `policy.py` (allow-list in code; filters the menu at startup and
checks again at call time), `agent.py` (the loop, 8 model calls max per
turn), `events.py` (startup and per-turn trace events), `wire_tap.py` (copies
raw JSON-RPC off the transport), `system_prompt.txt`.

Checks:

```bash
python host/scripted_tests.py     # no key; (e) launches the flights server
python host/wire_tap_checks.py    # no key; needs the bookings server running
```

The scripted tests need no API key, but test (e) launches the real flights
server over stdio, so they are key-free, not server-free. The wire tap check
books a trip on the running bookings server and cancels it again afterwards.

## Notes

- `"command": "python"` in `servers.json` is resolved to the interpreter
  running the host, so stdio servers always start inside the same venv.
- Servers log to stderr only. stdout is the MCP wire.
- `book_trip` computes the price from its own data and never accepts one
  from the caller. `MAX_BOOKING_KES = 150000` is a code rule in the server.

## Phases

Phase 3: host brain (Claude, agent loop, policy). Phase 4: web chat + bonnet
panel. Phase 5: token, scopes, confirmation. Demo 2: k3d, Redis, gateway.
