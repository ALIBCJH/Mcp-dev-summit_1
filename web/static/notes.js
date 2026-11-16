// Presenter notes: what to say at each beat. Press N to show or hide them.
// Pure lookup, keyed on the startup process or the turn step kind; the
// small overlay in app.js only displays what this returns.
"use strict";

const NOTES = {
  // Startup, by process.
  boot: { title: "Boot", lines: [
    "The host is our program. It reads servers.json: three servers, two over stdio, one over HTTP.",
    "Nothing has talked to anything yet. Traveller and Claude are just the two ends of the host.",
  ] },
  handshake: { title: "Handshake", lines: [
    "One connection at a time. The host starts the server, then sends server/discover.",
    "The reply names the protocol version and what the server can do: prompts, resources, tools.",
    "This is plain JSON-RPC. What you see on the wire is exactly what went over it.",
  ] },
  discovery: { title: "Discovery", lines: [
    "Now the host asks each server for its tools, resources and prompts: tools/list and friends.",
    "Flights has two tools, Hotels one tool plus a resource and a prompt, Bookings two tools.",
  ] },
  menu: { title: "Menu", lines: [
    "The policy is an allow-list in the host. Claude only ever sees what the policy offers.",
    "Five tools offered, none blocked today. The block list is where you would stop a dangerous tool.",
  ] },
  // Turns, by step kind.
  TurnStarted: { title: "The request", lines: ["The traveller types. The agent loop builds the first message for Claude with the tool menu attached."] },
  ModelCalled: { title: "Claude thinks", lines: ["One call to the Claude API. The row shows the stop reason: tool_use means Claude wants a tool, end_turn means it is done.", "The seconds and tokens are real, from the API response."] },
  ToolRequested: { title: "Claude asks for a tool", lines: ["Claude names the tool and its arguments. It cannot run anything itself; the host decides."] },
  PolicyDecided: { title: "The policy decides", lines: ["Allowed or denied, with a reason. A denied call never reaches a server; Claude is told why and carries on."] },
  WireMessage: { title: "On the wire", lines: ["tools/call goes to the server as JSON-RPC and the result comes back the same way. The tap shows both sides."] },
  ToolReturned: { title: "The tool answers", lines: ["The result text goes back to Claude as the tool's reply. An error is passed through as an error, not hidden."] },
  SimulatedReply: { title: "Fooled", lines: ["The hotel review carried an instruction. With Fooled LLM on, we pretend Claude obeyed it and asked to book the suite for ten nights.", "Watch the policy and the bookings limit stop it."] },
  FinalAnswer: { title: "Claude answers", lines: ["Claude writes the answer from the tool results. The scoreboard under it sums the whole turn."] },
  TurnFailed: { title: "The turn failed", lines: ["Something broke: a timeout or an API error. The loop reports it instead of inventing an answer."] },
  Reset: { title: "Reset", lines: ["Conversation cleared. The servers stay connected; only the chat history goes."] },
};

const Notes = {
  NOTES,
  // state: the strip state painted; kind: the step kind (turn steps).
  lookup(state, kind) {
    if (state && state.phase === "startup" && state.process && NOTES[state.process]) return NOTES[state.process];
    if (kind && NOTES[kind]) return NOTES[kind];
    return null;
  },
};

if (typeof module !== "undefined") module.exports = Notes;
