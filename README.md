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

## Web chat and bonnet panel (Phase 4)

```bash
./start_demo.sh              # bookings server, then the web app; Ctrl-C stops both
# or, in two terminals: python servers/bookings_server.py / python web/app.py
```

Open http://127.0.0.1:8000/ (bound to 127.0.0.1 only). Chat on the left,
the bonnet on the right: the five startup lines (paced, replayable, or
stepped with Space / Right arrow), then per turn every model call with its
full request, every tool request, policy decision, raw JSON-RPC message,
tool result, thinking summary and final answer. Purple is the Claude API,
teal is MCP, red is a denial or an error. Buttons send the standard Diani
request, a status check for the cancelled flight NY415, and the plan-trip
prompt. Reset clears the conversation and the turn events, keeps the
startup events, and switches the fooled-LLM simulation off.

"Simulate fooled LLM" (server-side toggle): once per turn, after the model
has received hotel results that carry the poisoned review, the next reply
is replaced by a synthetic tool request for exactly what the review asks
(`host/fooled_llm.py` reads it from the data files). A yellow banner marks
the swap. The policy check, the tools/call to Bookings, its spending-limit
error and the next Claude call are all real.

Routes: `GET /api/state`, `GET /api/events?after=N` (Server-Sent Events,
one `id` = sequence number per event, `Last-Event-ID` honoured), `POST
/api/chat {"text"}` (409 while a turn runs, 60-second turn timeout), `POST
/api/reset`, `POST /api/fooled {"on"}`. Strings shaped like an API key are
redacted before they leave the server (`web/serialize.py`).

Files: `web/app.py` (routes and all state), `web/event_log.py` (sequence
numbers, subscribers), `web/serialize.py`, `web/static/` (plain HTML, CSS
and JS, no build step), `host/commands.py` (`/attach` and `/plan-trip`,
shared with the CLI), `host/fooled_llm.py`.

```bash
python host/web_tests.py     # no key; starts its own bookings server on a free port
```

## Notes

- `"command": "python"` in `servers.json` is resolved to the interpreter
  running the host, so stdio servers always start inside the same venv.
- Servers log to stderr only. stdout is the MCP wire.
- `book_trip` computes the price from its own data and never accepts one
  from the caller. `MAX_BOOKING_KES = 150000` is a code rule in the server.

## Phases

Phase 3: host brain (Claude, agent loop, policy). Phase 4: web chat + bonnet
panel. Phase 5: token, scopes, confirmation. Demo 2: k3d, Redis, gateway.
