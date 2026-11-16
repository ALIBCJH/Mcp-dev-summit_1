// Pure: events in, strip states out. No DOM, no timers, so it runs in Node
// for tests and a reload rebuilds the exact same picture from the history.
"use strict";

const FLOW_TABLE = typeof FLOW !== "undefined" ? FLOW : require("./flow_data.js");

// The four processes of the kernel's startup story, in order. The reducer
// stamps each startup state with one; captions, the chips strip, the title
// cards and the chapter titles all read it from here.
const PROCESSES = [
  { id: "boot",      name: "Boot",      blurb: "the host reads its config and builds itself" },
  { id: "handshake", name: "Handshake", blurb: "host and servers agree on the protocol" },
  { id: "discovery", name: "Discovery", blurb: "each server lists its tools, resources and prompts" },
  { id: "menu",      name: "Menu",      blurb: "the policy decides what Claude may see" },
];

const FlowState = {
  PROCESSES,
  processOf(state) { return PROCESSES.find((p) => p.id === state.process) || null; },
  processIndex(id) { return PROCESSES.findIndex((p) => p.id === id); },

  initialState() {
    const nodes = {};
    for (const n of FLOW_TABLE.nodes) nodes[n.id] = { status: "idle", label: "" };
    const edges = {};
    for (const e of FLOW_TABLE.edges) edges[e.id] = "idle";
    const servers = {};
    for (const id of Object.values(FLOW_TABLE.serverOf)) servers[id] = { tools: [], blocked: [], stage: "" };
    // built: ids drawn on the stage so far (nodes, the "host" container, the
    // "mcp" band). Startup builds the picture piece by piece; see the handlers.
    // focus: null for the overview, or the one connection the stage shows
    // large while a server connects and answers the handshake.
    return { nodes, edges, servers, phase: "startup", stepNumber: 0, caption: "", claudeWaiting: false, simulatedPending: false, built: [], focus: null, wire: {}, process: null };
  },

  // Returns { state, step }. `step` is true when the event is a beat the
  // strip shows; otherwise the state is returned unchanged.
  reduce(state, ev) {
    const handler = FlowState.handlers[ev.type];
    if (!handler) return { state, step: false };
    const next = JSON.parse(JSON.stringify(state));
    // Whatever was lit last beat is now done; special states persist until replaced.
    for (const n of Object.values(next.nodes)) if (n.status === "active") n.status = "done";
    for (const id of Object.keys(next.edges)) if (next.edges[id] === "fwd" || next.edges[id] === "back") next.edges[id] = "done";
    const caption = handler(next, ev);
    if (caption === null) {
      // Not a beat. A quiet handler may still note something for a later beat.
      const quiet = FlowState.quiet[ev.type];
      if (!quiet) return { state, step: false };
      const kept = JSON.parse(JSON.stringify(state));
      quiet(kept, ev);
      return { state: kept, step: false };
    }
    next.stepNumber += 1;
    next.caption = caption;
    return { state: next, step: true };
  },

  stepsFrom(events) {
    const steps = [];
    let state = FlowState.initialState();
    for (const ev of events) {
      const r = FlowState.reduce(state, ev);
      state = r.state;
      if (r.step) steps.push({ seq: ev.seq, type: ev.type, caption: state.caption, stepNumber: state.stepNumber, state });
    }
    return steps;
  },

  // number: the step number to show, when the caller counts steps itself
  // (the panel merges a tool's request and reply into one step).
  captionText(state, total, number) {
    const n = number || state.stepNumber;
    const where = state.phase === "startup" ? "Startup " : "Step ";
    const proc = FlowState.processOf(state);
    return `${proc ? `${proc.name} · ` : ""}${where}${n}${total ? ` of ${total}` : ""}: ${state.caption}`;
  },
};

// ---- helpers --------------------------------------------------------------

function nodeOfServer(name) { return FLOW_TABLE.serverOf[name] || null; }
function nodeLabel(id) { const n = FLOW_TABLE.nodes.find((x) => x.id === id); return n ? n.label : id; }
function nodeKind(id) { const n = FLOW_TABLE.nodes.find((x) => x.id === id); return n && n.sub ? ` (${n.sub})` : ""; }
function short(text, max) { text = String(text || "").replace(/\s+/g, " ").trim(); return text.length > max ? text.slice(0, max - 1) + "…" : text; }
function argsShort(args) {
  return Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
}
function light(state, id, status, label) { state.nodes[id] = { status, label: label || "" }; }
function build(state, ...ids) { for (const id of ids) if (!state.built.includes(id)) state.built.push(id); }
function buildAll(state) {
  build(state, ...FLOW_TABLE.nodes.map((n) => n.id), ...FLOW_TABLE.containers.map((c) => c.id), FLOW_TABLE.band.id);
}
function clearTurn(state) {
  for (const id of Object.keys(state.nodes)) state.nodes[id] = { status: "idle", label: "" };
  for (const id of Object.keys(state.edges)) state.edges[id] = "idle";
  state.claudeWaiting = false;
  state.simulatedPending = false;
  state.focus = null;
  state.process = null;
}
function wireOf(state, server, which) { const w = (state.wire || {})[server]; return w && w[which] ? w[which] : null; }
function nodeSub(id) { const n = FLOW_TABLE.nodes.find((x) => x.id === id); return n ? n.sub : ""; }
function connectionNumber(state, id) {
  // Servers in table order that have connected so far, this one included.
  const ids = Object.values(FLOW_TABLE.serverOf);
  return ids.filter((x) => x === id || (state.servers[x].stage && state.servers[x].stage !== "configured")).indexOf(id) + 1;
}

// Quiet handlers run for events that are not beats, so a later beat can
// show what they carried. Startup wire traffic is kept per server: the
// handshake request and its reply arrive before the connect beat.
FlowState.quiet = {
  WireMessage(s, ev) {
    if (s.phase !== "startup" || !ev.server) return;
    s.wire[ev.server] = s.wire[ev.server] || { request: null, response: null };
    s.wire[ev.server][ev.direction === "->" ? "request" : "response"] = { method: ev.method, json: ev.json || "" };
  },
};

FlowState.handlers = {
  ConfigLoaded(s, ev) {
    s.phase = "startup"; s.stepNumber = 0;
    clearTurn(s);
    // The stage starts empty: the host appears with its two ends; servers
    // and the MCP band follow as each server connects.
    s.process = "boot";
    s.built = [];
    build(s, "host", ...FLOW_TABLE.containers.find((c) => c.id === "host").members, "traveller", "claude");
    for (const srv of ev.servers || []) { const id = nodeOfServer(srv.name); if (id) s.servers[id].stage = "configured"; }
    return `Host loads ${(ev.servers || []).length} servers from servers.json`;
  },
  ServerConnected(s, ev) {
    const id = nodeOfServer(ev.server); if (!id) return null;
    s.servers[id].stage = "connected";
    s.process = "handshake";
    build(s, FLOW_TABLE.band.id, id);
    light(s, id, "active", "connected");
    s.edges[`policy-${id}`] = "fwd";
    s.focus = { id, number: connectionNumber(s, id), total: Object.keys(FLOW_TABLE.serverOf).length, stage: "connected",
      transport: nodeSub(id), protocol: "", capabilities: [], handshake: "", request: wireOf(s, ev.server, "request"), response: null };
    return `Host connects to ${nodeLabel(id)}${nodeKind(id)}`;
  },
  Handshake(s, ev) {
    const id = nodeOfServer(ev.server); if (!id) return null;
    s.servers[id].stage = "handshake";
    s.process = "handshake";
    light(s, id, "active", ev.protocol_version);
    s.edges[`policy-${id}`] = "back";
    s.focus = { id, number: connectionNumber(s, id), total: Object.keys(FLOW_TABLE.serverOf).length, stage: "handshake",
      transport: nodeSub(id), protocol: ev.protocol_version, capabilities: (ev.capabilities || []).slice(), handshake: ev.handshake,
      request: wireOf(s, ev.server, "request"), response: wireOf(s, ev.server, "response") };
    return `${nodeLabel(id)} answers ${ev.handshake}: protocol ${ev.protocol_version}, ${(ev.capabilities || []).join(", ")}`;
  },
  ToolsDiscovered(s, ev) {
    const id = nodeOfServer(ev.server); if (!id) return null;
    s.servers[id].stage = "discovered";
    s.process = "discovery";
    s.servers[id].tools = (ev.tool_names || []).slice();
    light(s, id, "active", "discovered");
    s.edges[`policy-${id}`] = "back";
    s.focus = null;   // discovery is shown on the overview, tools beside each server
    const r = (ev.resource_uris || []).length, p = (ev.prompt_names || []).length;
    return `${nodeLabel(id)} offers ${ev.tool_names.length} tool${ev.tool_names.length === 1 ? "" : "s"}, ${r} resource${r === 1 ? "" : "s"}, ${p} prompt${p === 1 ? "" : "s"}`;
  },
  MenuBuilt(s, ev) {
    for (const srv of Object.values(s.servers)) srv.blocked = [];
    for (const b of ev.blocked || []) { const id = nodeOfServer(b.server); if (id) s.servers[id].blocked.push(b.name); }
    light(s, "policy", "active", `offered ${ev.offered.length}`);
    s.focus = null;
    s.process = "menu";
    return `Policy offers ${ev.offered.length} tools to Claude, blocks ${(ev.blocked || []).length}`;
  },
  TurnStarted(s, ev) {
    s.phase = "turn"; s.stepNumber = 0;
    clearTurn(s);
    buildAll(s);   // a turn needs the whole picture, whatever the history held
    light(s, "traveller", "active", "asks");
    light(s, "claude", "waiting", "…");
    s.claudeWaiting = true;
    s.edges["traveller-loop"] = "fwd";
    return `Traveller asks: "${short(ev.text, 70)}"`;
  },
  ModelCalled(s, ev) {
    s.claudeWaiting = false;
    s.edges["claude-loop"] = "fwd";
    if (s.simulatedPending) {
      s.simulatedPending = false;
      light(s, "claude", "replaced", "replaced");
      return `Synthetic reply stands in for Claude call ${ev.call_number} of ${ev.max_calls} (no API call)`;
    }
    light(s, "claude", "active", `${ev.elapsed_seconds} s · ${ev.input_tokens} in / ${ev.output_tokens} out`);
    return `Claude call ${ev.call_number} of ${ev.max_calls} answers in ${ev.elapsed_seconds} s (stop: ${ev.stop_reason})`;
  },
  ToolRequested(s, ev) {
    s.claudeWaiting = false;
    if (s.nodes.claude.status === "waiting") s.nodes.claude = { status: "done", label: "" };
    light(s, "loop", "active", ev.name);
    s.edges["claude-loop"] = "fwd";
    return `Claude asks for ${ev.name}(${short(argsShort(ev.args), 60)})`;
  },
  PolicyDecided(s, ev) {
    s.edges["loop-policy"] = "fwd";
    if (ev.allowed) { light(s, "policy", "active", "allowed"); return `Policy allows ${ev.name}`; }
    light(s, "policy", "denied", "DENIED");
    return `Policy denies ${ev.name}: ${short(ev.reason, 80)}`;
  },
  WireMessage(s, ev) {
    if (s.phase !== "turn") return null;            // startup wire traffic is not a beat
    const id = nodeOfServer(ev.server); if (!id) return null;
    if (ev.direction === "->") {
      light(s, id, "active", ev.method);
      s.edges[`policy-${id}`] = "fwd";
      return `Host sends ${ev.method} to ${nodeLabel(id)}${nodeKind(id)}`;
    }
    light(s, id, "active", ev.method === "error" ? "error" : "reply");
    s.edges[`policy-${id}`] = "back";
    return `${nodeLabel(id)} replies over JSON-RPC (${ev.method})`;
  },
  ToolReturned(s, ev) {
    light(s, "loop", ev.is_error ? "error" : "active", ev.is_error ? "error" : "ok");
    light(s, "claude", "waiting", "…");
    s.claudeWaiting = true;
    if (ev.is_error) return `${ev.name} returns an error: ${short(ev.text.replace(/^Error executing tool \w+: /, ""), 80)}`;
    return `${ev.name} returns ${ev.text.length.toLocaleString("en-US")} characters`;
  },
  FinalAnswer(s, ev) {
    s.claudeWaiting = false;
    light(s, "claude", "done", "");
    light(s, "traveller", "active", "answered");
    s.edges["claude-loop"] = "fwd";
    s.edges["traveller-loop"] = "back";
    return `Claude answers the traveller (${ev.reason})`;
  },
  SimulatedReply(s, ev) {
    if (!ev.tool) return `Simulation armed, no injection in the results, nothing replaced`;
    s.claudeWaiting = false;
    s.simulatedPending = true;
    light(s, "claude", "replaced", "replaced");
    return `SIMULATED: Claude's reply replaced with ${ev.tool}(${short(argsShort(ev.args), 60)})`;
  },
  TurnFailed(s, ev) {
    s.claudeWaiting = false;
    if (s.nodes.claude.status === "waiting") s.nodes.claude = { status: "done", label: "" };
    light(s, "loop", "error", "error");
    return `Turn failed: ${short(ev.error, 90)}`;
  },
  Reset(s) {
    s.phase = "turn"; s.stepNumber = 0;
    clearTurn(s);
    return "Conversation reset";
  },
};

if (typeof module !== "undefined") module.exports = FlowState;
