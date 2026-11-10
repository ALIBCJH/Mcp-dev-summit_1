#!/usr/bin/env bash
# Start the Bookings server, wait until it answers, start the web app, and
# stop both on Ctrl-C. Opens nothing. Relies on bash: trap, $!, kill, wait,
# and on curl for the readiness poll.
#
#   ./start_demo.sh            (web app on http://127.0.0.1:8000/)
#   WEB_PORT=8080 ./start_demo.sh

cd "$(dirname "$0")"
PY=.venv/bin/python
BOOKINGS_PORT="${PORT:-9000}"
WEB_PORT="${WEB_PORT:-8000}"

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "stopping..."
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null
  [ -n "$BOOKINGS_PID" ] && kill "$BOOKINGS_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

PORT="$BOOKINGS_PORT" "$PY" servers/bookings_server.py &
BOOKINGS_PID=$!

# Any HTTP response counts as up (no -f): the MCP endpoint answers a bare GET
# with an error status, which is still a running server.
echo -n "waiting for bookings on port $BOOKINGS_PORT "
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$BOOKINGS_PORT/mcp"; then
    echo "up"
    break
  fi
  if ! kill -0 "$BOOKINGS_PID" 2>/dev/null; then
    echo; echo "bookings server exited; see the lines above"; exit 1
  fi
  echo -n "."
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$BOOKINGS_PORT/mcp"; then
  echo; echo "bookings server did not answer within 20 seconds"; exit 1
fi

WEB_PORT="$WEB_PORT" "$PY" web/app.py &
WEB_PID=$!
echo "web app starting; open http://127.0.0.1:$WEB_PORT/   (Ctrl-C stops both)"
wait "$WEB_PID"
