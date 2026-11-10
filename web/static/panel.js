// Renders events into the bonnet panel. One function per event type.
// app.js feeds events in sequence order; this file never talks to the server.
"use strict";

const STARTUP_TYPES = new Set(["ConfigLoaded", "ServerConnected", "Handshake", "ToolsDiscovered", "MenuBuilt"]);
const STEP_MS = 400; // pacing of the startup replay, in the browser

const Panel = {
  startupEvents: [],      // every event received before MenuBuilt, in order
  startupComplete: false,
  lines: [],              // the five startup lines, built from startupEvents
  revealed: 0,
  timer: null,
  stepMode: false,
  turnCount: 0,
  currentTurn: null,      // the <section class="turn"> rows go into
  pendingSimulated: false, // the next ModelCalled is the synthetic reply

  handle(ev) {
    if (!this.startupComplete) {
      this.startupEvents.push(ev);
      if (ev.type === "MenuBuilt") { this.startupComplete = true; this.buildLines(); this.replay(); }
      return;
    }
    const fn = this["on" + ev.type];
    if (fn) fn.call(this, ev); else this.rowInto(row("neutral", ev.type, JSON.stringify(ev).slice(0, 200)));
    this.scrollToEnd();
  },

  // ---- startup: five lines, paced --------------------------------------
  buildLines() {
    const evs = this.startupEvents;
    const of = (t) => evs.filter(e => e.type === t);
    const wires = (methods) => evs.filter(e => e.type === "WireMessage" && methods.includes(e.method));
    const cfg = of("ConfigLoaded")[0];
    const hs = of("Handshake");
    const disc = of("ToolsDiscovered");
    const menu = of("MenuBuilt")[0];
    const serverList = (cfg ? cfg.servers : []).map(s => `${s.name} (${s.kind}: ${s.where})`).join(", ");

    this.lines = [
      { family: "neutral", label: "config", head: `${cfg ? cfg.servers.length : 0} servers from servers.json: ${serverList}`, detail: () => pretty(cfg) },
      { family: "mcp", label: "connected", head: of("ServerConnected").map(e => e.server).join(", "), detail: () => pretty(of("ServerConnected")) },
      { family: "mcp", label: "handshake", head: hs.map(e => `${e.server} (${e.server_name}) ${e.protocol_version} via ${e.handshake} [${e.capabilities.join(", ")}]`).join(" · "), detail: () => this.wireDetail(hs, wires(["server/discover", "response", "error"]), ["server/discover"]) },
      { family: "mcp", label: "discovered", head: disc.map(e => `${e.server}: tools ${e.tool_names.join(", ") || "-"}` + (e.resource_uris.length ? `; resources ${e.resource_uris.join(", ")}` : "") + (e.prompt_names.length ? `; prompts ${e.prompt_names.join(", ")}` : "")).join(" · "), detail: () => this.wireDetail(disc, wires(["tools/list", "resources/list", "prompts/list", "response", "error"]), ["tools/list", "resources/list", "prompts/list"]) },
      { family: "neutral", label: "menu", head: menu ? `offered ${menu.offered.length}: ${menu.offered.join(", ")} · blocked ${menu.blocked.length}: ${menu.blocked.map(b => `${b.name} [${b.server}: ${b.reason}]`).join(", ") || "none"}` : "", detail: () => pretty(menu) },
    ];
  },

  // Detail of a startup line: the events as JSON, then the matching wire
  // messages. Responses carry no method, so a response is shown when it
  // follows one of the wanted requests in wire order.
  wireDetail(events, wireEvents, wanted) {
    const wrap = el("div");
    wrap.appendChild(labelled("events", pretty(events)));
    const list = el("div");
    let keep = false;
    for (const w of wireEvents) {
      if (w.direction === "->") keep = wanted.includes(w.method);
      if (!keep) continue;
      list.appendChild(this.wireRow(w));
    }
    wrap.appendChild(labelled("raw JSON-RPC", list));
    return wrap;
  },

  wireRow(w) {
    const arrow = w.direction === "->" ? "host → " + w.server : w.server + " → host";
    const head = `${arrow}  ${w.method}  ${w.json.slice(0, WIRE_PREVIEW)}${w.json.length > WIRE_PREVIEW ? " …" : ""}`;
    const r = row("mcp", "wire", head, () => pretty(w.json));
    r.classList.add("wire-row");
    return r;
  },

  replay() {
    this.stopTimer();
    const holder = document.getElementById("startup-lines");
    holder.textContent = "";
    this.revealed = 0;
    document.getElementById("startup").classList.remove("collapsed");
    if (!this.lines.length) return;
    if (this.stepMode) { this.revealNext(); return; }   // first line now, rest on key
    this.revealNext();
    this.timer = setInterval(() => { if (!this.revealNext()) this.stopTimer(); }, STEP_MS);
  },

  revealNext() {
    if (this.revealed >= this.lines.length) return false;
    const line = this.lines[this.revealed++];
    const r = row(line.family, line.label, line.head, line.detail);
    document.getElementById("startup-lines").appendChild(r);
    this.scrollToEnd();
    return this.revealed < this.lines.length;
  },

  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },

  collapseStartup() {
    this.stopTimer();
    // Make sure every line exists, so the expanded view is complete.
    while (this.revealNext()) { /* reveal all */ }
    document.getElementById("startup").classList.add("collapsed");
  },

  // ---- turns --------------------------------------------------------------
  newTurn(ev) {
    if (this.turnCount === 0) this.collapseStartup();
    this.turnCount += 1;
    const sec = el("section", "turn");
    const title = el("div", "turn-title", `TURN ${this.turnCount}  `);
    const q = el("span", "q", JSON.stringify(ev.text.length > 120 ? ev.text.slice(0, 120) + "…" : ev.text));
    title.appendChild(q);
    if (ev.note) title.appendChild(el("span", "q", `  (${ev.note})`));
    sec.appendChild(title);
    document.getElementById("turns").appendChild(sec);
    this.currentTurn = sec;
  },

  rowInto(node) {
    if (!this.currentTurn) {
      // Events without a TurnStarted (e.g. a page loaded mid-turn before the
      // first event, or wire traffic outside a turn) still need a home.
      this.newTurn({ text: "(events before the first turn marker)", note: "" });
    }
    this.currentTurn.appendChild(node);
  },

  onTurnStarted(ev) { this.newTurn(ev); },

  onModelCalled(ev) {
    const simulated = this.pendingSimulated; this.pendingSimulated = false;
    const head = `Model call ${ev.call_number}/${ev.max_calls}, ${ev.elapsed_seconds}s, ${fmtInt(ev.input_tokens)} in / ${fmtInt(ev.output_tokens)} out, ${ev.messages.length} messages, ${ev.tools.length} tools, stop_reason=${ev.stop_reason}` + (simulated ? "  [synthetic reply, no API call]" : "");
    const detail = () => {
      const wrap = el("div");
      wrap.appendChild(labelled("system prompt", clip(ev.system)));
      wrap.appendChild(labelled(`messages (${ev.messages.length})`, pretty(ev.messages)));
      wrap.appendChild(labelled(`tools (${ev.tools.length})`, pretty(ev.tools)));
      wrap.appendChild(labelled("response", pretty(ev.response)));
      return wrap;
    };
    this.rowInto(row("api", simulated ? "simulated" : "model", head, detail));
    for (const block of ev.response || []) {
      if (block.type === "thinking" && block.thinking) {
        const r = row("api", "thinking", "", null);
        r.querySelector(".head").appendChild(el("span", "thinking", block.thinking));
        this.rowInto(r);
      } else if (block.type === "redacted_thinking") {
        this.rowInto(row("api", "thinking", "[redacted by the API]", null));
      }
    }
  },

  onToolRequested(ev) {
    this.rowInto(row("mcp", "tool requested", `${ev.name}(${JSON.stringify(ev.args)})`, () => pretty(ev)));
  },

  onPolicyDecided(ev) {
    this.rowInto(row(ev.allowed ? "neutral" : "denied", ev.allowed ? "policy allowed" : "policy DENIED", `${ev.name}: ${ev.reason}`, null));
  },

  onWireMessage(ev) { this.rowInto(this.wireRow(ev)); },

  onToolReturned(ev) {
    const family = ev.is_error ? "denied" : "mcp";
    const head = `${ev.name} returned ${ev.is_error ? "ERROR" : "ok"} (${fmtInt(ev.text.length)} characters)`;
    this.rowInto(row(family, "tool returned", head, () => clip(ev.text)));
  },

  onFinalAnswer(ev) {
    const note = ev.reason === "end_turn" ? "" : `  (reason: ${ev.reason})`;
    this.rowInto(row("api", "final answer", `end of turn${note}`, () => clip(ev.text)));
  },

  onTurnFailed(ev) {
    this.rowInto(row("denied", "ERROR", ev.error, null));
  },

  onSimulatedReply(ev) {
    if (ev.tool) {
      this.pendingSimulated = true;
      const b = el("div", "banner", ev.note);
      b.appendChild(el("small", "", `Synthetic reply requests ${ev.tool}(${JSON.stringify(ev.args)}). The policy check, the tools/call to the Bookings server, its answer and the next Claude call are real.`));
      this.rowInto(b);
    } else {
      this.rowInto(row("neutral", "simulation", ev.note, null));
    }
  },

  onReset(ev) {
    // Clears the turns only. A startup replay in progress keeps going: a
    // Reset event is always in the history after a reset, and it must not
    // cut the paced reveal short on reload.
    document.getElementById("turns").textContent = "";
    this.currentTurn = null;
    this.turnCount = 0;
    this.pendingSimulated = false;
    document.getElementById("startup").classList.remove("collapsed");
    if (typeof App !== "undefined") App.setFooled(ev.fooled);
  },

  scrollToEnd() {
    const p = document.getElementById("panel");
    p.scrollTop = p.scrollHeight;
  },
};
