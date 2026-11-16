// The one table behind the flow strip: nodes, edges, the Host container and
// the MCP band. The renderer and the state reducer both read it, so Phase 5
// adds a Confirm node and edge here and nowhere else.
"use strict";

const FLOW = {
  // 1040 wide: the right-hand 220 units hold the tool names beside the servers.
  viewBox: [0, 0, 1040, 340],
  nodes: [
    { id: "traveller", label: "Traveller", sub: "",           family: "neutral", x: 70,  y: 150, w: 130, h: 54 },
    { id: "claude",    label: "Claude",    sub: "API",        family: "api",     x: 290, y: 52,  w: 150, h: 54 },
    { id: "loop",      label: "Agent loop", sub: "",          family: "neutral", x: 290, y: 205, w: 150, h: 54 },
    { id: "policy",    label: "Policy",    sub: "allow-list", family: "neutral", x: 505, y: 205, w: 130, h: 54 },
    { id: "flights",   label: "Flights",   sub: "stdio",      family: "mcp",     x: 750, y: 48,  w: 130, h: 54 },
    { id: "hotels",    label: "Hotels",    sub: "stdio",      family: "mcp",     x: 750, y: 160, w: 130, h: 54 },
    { id: "bookings",  label: "Bookings",  sub: "HTTP",       family: "mcp",     x: 750, y: 272, w: 130, h: 54 },
  ],
  // arrows: "both" draws a head at each end, "one" only at `to`.
  edges: [
    { id: "traveller-loop",  from: "traveller", to: "loop",     arrows: "both", family: "neutral" },
    { id: "claude-loop",     from: "claude",    to: "loop",     arrows: "both", family: "api" },
    { id: "loop-policy",     from: "loop",      to: "policy",   arrows: "one",  family: "neutral" },
    { id: "policy-flights",  from: "policy",    to: "flights",  arrows: "both", family: "mcp" },
    { id: "policy-hotels",   from: "policy",    to: "hotels",   arrows: "both", family: "mcp" },
    { id: "policy-bookings", from: "policy",    to: "bookings", arrows: "both", family: "mcp" },
  ],
  // Claude is deliberately outside the Host box: it is a remote API.
  containers: [{ id: "host", label: "Host", members: ["loop", "policy"], pad: 24 }],
  band: { id: "mcp", label: "MCP (JSON-RPC)", x: 625, w: 56 },
  // The focus stage: one connection at a time, large. Host on the left, the
  // MCP band in the middle, the server on the right; x/y are box centres.
  focusStage: {
    host:   { x: 200, y: 120, w: 280, h: 92 },
    band:   { x: 480, w: 80 },
    server: { x: 840, y: 120, w: 280, h: 92 },
    titleY: 28, marginX: 60,
    packet: { from: 400, to: 640, y: 120, w: 210, h: 40 },   // the JSON-RPC message travelling the line
  },
  // WireMessage.server / ServerConnected.server -> node id
  serverOf: { flights: "flights", hotels: "hotels", bookings: "bookings" },
};

if (typeof module !== "undefined") module.exports = FLOW;
