// Renders events into the bonnet panel. One function per event type.
// app.js feeds events in sequence order; this file never talks to the server.
//
// Rows are built the moment an event arrives but stay hidden until the
// reveal controller (reveal.js) shows them, on the same beat as the strip.
// History (what already happened before this page loaded) is shown at once.
"use strict";

const FOCUS_WEIGHT = 4;   // how many dwells a connection chapter (focus view) stays on screen
const CARD_WEIGHT = 2;    // extra dwells for the beat that opens a process: its title card plays first

const Panel = {
  startupEvents: [],      // every event received before MenuBuilt, in order
  startupComplete: false,
  lines: [],              // the five startup lines, built from startupEvents
  lineRows: [],           // their DOM rows, hidden until their beat
  turnCount: 0,
  currentTurn: null,      // the <section class="turn"> rows go into
  pendingSimulated: false, // the next ModelCalled is the synthetic reply
  instantUntil: 0,        // events with seq <= this are history
  flowState: null,        // FlowState state of everything received so far
  startupSteps: [],       // beats of the startup, for Replay startup
  turnSteps: [],          // beats of the last turn, for Replay turn
  sequenceBase: null,     // strip state before the current sequence began
  turnBase: null,         // strip state before the last turn began (Replay turn)
  turnOpen: false,        // a turn is running on the server
  replayTotal: null,      // beats in the sequence being replayed (null = live)
  rowsBuilt: [],          // rows made by the on<Event> handler in progress
  currentRows: [],        // rows of the step on screen (accent, not dimmed)
  scrollTarget: null,     // the node kept in view (a row, or a turn's section)
  reveal: null,
  stats: {},              // timing: when FinalAnswer arrived vs was shown
  turnEvents: [],         // this turn's events, for the scoreboard
  tallies: [],            // one scoreboard per finished turn (the session, for the closing card)

  init() {
    this.reveal = Reveal.create({
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      show: (step) => this.show(step, true),
      hide: (step) => this.hide(step),
      changed: () => this.onChanged(),
    });
  },

  handle(ev) {
    if (!this.flowState) this.flowState = FlowState.initialState();
    if (!this.startupComplete) {
      this.startupEvents.push(ev);
      if (ev.type === "MenuBuilt") {
        this.startupComplete = true; this.buildLines(); this.buildStartupSteps();
        // On page load the opening (welcome, then both halves boot) runs
        // first; "Replay startup" never shows it.
        if (Curtain.wanted(location.search)) {
          Curtain.run(() => { this.replay(); if (typeof App !== "undefined") App.spotlightThenDock(); });
        } else this.replay();
      }
      return;
    }
    const base = this.flowState;
    if (ev.type === "TurnStarted") this.turnEvents = [];
    this.turnEvents.push(ev);
    if (ev.type === "FinalAnswer" || ev.type === "TurnFailed") this.tallies.push(Score.tally(this.turnEvents));
    const step = this.render(ev);
    if (ev.type === "TurnStarted") this.sequenceBase = this.turnBase = base;
    if (Reveal.isHistory(ev, this.instantUntil)) {
      this.remember(step);
      this.show(step, false);
      return;
    }
    if (ev.type === "TurnStarted") { this.reveal.end(); this.reveal.begin(true); }
    if (ev.type === "Reset") { this.reveal.reset(); this.reveal.begin(true); }
    this.replayTotal = null;
    const request = this.requestFor(step);
    if (request) { request.half = step; step.number = request.number; return; }   // reply rides on the request's beat
    this.remember(step);
    this.reveal.add(step);
  },

  // Build the rows and the strip state for one event, rows hidden.
  render(ev) {
    this.rowsBuilt = [];
    const fn = this["on" + ev.type];
    if (fn) fn.call(this, ev); else this.rowInto(row("neutral", ev.type, JSON.stringify(ev).slice(0, 200)));
    const r = FlowState.reduce(this.flowState, ev);
    this.flowState = r.state;
    if (ev.type === "TurnStarted") { this.turnSteps = []; this.turnOpen = true; }
    if (ev.type === "FinalAnswer" || ev.type === "TurnFailed") this.turnOpen = false;
    return {
      kind: ev.type, seq: ev.seq, arrivedAt: Date.now(), rows: this.rowsBuilt,
      state: r.step ? r.state : null, half: null,
      wire: ev.type === "WireMessage" ? { server: ev.server, direction: ev.direction } : null,
    };
  },

  // Turn steps are numbered as the presenter sees them: one per key press,
  // a merged reply sharing its request's number.
  remember(step) {
    if (!step.state || step.state.phase !== "turn") return;
    this.turnSteps.push(step);
    step.number = this.turnSteps.length;
  },

  // A tool's request and its reply share one beat: the reply row and the
  // reverse animation come in at the half-way point of the dwell.
  requestFor(step) {
    const p = this.reveal.pending();
    const ok = p && step.wire && step.wire.direction === "<-" && p.wire && p.wire.direction === "->"
      && p.wire.server === step.wire.server && !p.half;
    return ok ? p : null;
  },

  // ---- showing and hiding steps --------------------------------------------
  show(step, viaController) {
    const paint = viaController || this.reveal.counter().queued === 0;
    this.revealRows(step.rows);
    if (step.state && paint) this.paint(step, step.state, viaController);
    if (!step.half) { this.scrollToCurrent(); return; }
    const dwell = this.reveal.dwell();
    if (viaController && dwell) {
      setTimeout(() => {
        if (!this.reveal.isShown(step)) return;              // hidden again meanwhile
        this.showHalf(step, this.reveal.last() === step);
      }, dwell / 2);
    } else {
      this.showHalf(step, paint);
    }
    this.scrollToCurrent();
  },
  showHalf(step, paint) {
    this.revealRows(step.half.rows);
    if (step.half.state && paint) this.paint(step.half, step.half.state);
    this.scrollToCurrent();
  },
  hide(step) {
    for (const n of step.rows) n.classList.add("unrevealed");
    if (step.half) for (const n of step.half.rows) n.classList.add("unrevealed");
    const prev = this.reveal.last();
    const back = prev ? (prev.half || prev) : null;
    const prevRows = prev ? prev.rows.concat(prev.half ? prev.half.rows : []) : [];
    this.setCurrent(prevRows);
    this.scrollTarget = prevRows.length ? prevRows[prevRows.length - 1] : null;
    if (back && back.state) this.paint(back, back.state);
    else if (this.sequenceBase) FlowStrip.apply(this.sequenceBase, "Ready");
    this.scrollToCurrent();
  },

  revealRows(rows) {
    for (const n of rows) n.classList.remove("unrevealed");
    this.setCurrent(rows);
    if (rows.length) this.scrollTarget = rows[rows.length - 1];
  },
  // The current step's rows carry the accent; everything earlier dims.
  setCurrent(rows) {
    for (const n of this.currentRows) { n.classList.remove("current", "fresh"); n.classList.add("seen"); }
    this.currentRows = rows.filter((n) => n.matches(".row, .banner"));
    for (const n of this.currentRows) { n.classList.remove("seen"); n.classList.add("fresh"); }
    const last = this.currentRows[this.currentRows.length - 1];
    if (last) last.classList.add("current");
  },

  // A beat that opens a new process gets its title card first, then the
  // paint; only when the controller shows it at a timed or manual pace
  // (history and Instant paint straight away).
  paint(step, state, viaController) {
    const total = state.phase === "startup" ? this.startupSteps.length : this.replayTotal;
    const apply = () => FlowStrip.apply(state, FlowState.captionText(state, total, step.number), this.reveal.live ? step.arrivedAt : undefined);
    const proc = FlowState.processOf(state);
    const card = proc && proc.id !== this.announced && viaController && this.reveal.dwell() !== 0;
    if (proc) this.announced = proc.id;
    if (card) FlowStrip.announce(proc, apply); else apply();
    if (typeof Notes !== "undefined" && typeof App !== "undefined") App.showNotes(Notes.lookup(state, step.kind));
    if (step.kind === "FinalAnswer" || step.kind === "TurnFailed") {
      this.stats.finalShownAt = performance.now();
      this.showScore(step);
    }
  },

  // The scoreboard: one line under the turn in the panel, and in the chat.
  showScore(step) {
    const tally = this.tallies[this.tallies.length - 1];
    if (!tally || !this.currentTurn || this.currentTurn.querySelector(".scoreboard")) return;
    const text = Score.text(tally);
    this.currentTurn.appendChild(el("div", "scoreboard", text));
    if (typeof App !== "undefined") App.chatLine("score", "", text);
  },

  onChanged() {
    const c = this.reveal.counter();
    this.showPending(c.queued > 0 || this.turnOpen);
    if (typeof App !== "undefined") App.updateHint(c, this.reveal.mode);
  },

  // Flush on send: the previous turn's unrevealed steps and a held answer show now.
  flush() { this.reveal.end(); },

  // fn runs when the answer may appear in the chat: at once unless the pace holds it.
  whenAnswerShown(fn) {
    if (!this.reveal.holds()) { fn(); return; }
    this.reveal.onRevealed((s) => s.kind === "FinalAnswer", () => fn());
  },

  showPending(on) {
    const old = document.querySelector(".pending");
    if (old) old.remove();
    if (!on || !this.currentTurn) return;
    const p = el("div", "pending");
    for (let i = 0; i < 3; i++) p.appendChild(el("span", "", "●"));
    this.currentTurn.appendChild(p);
  },

  // ---- startup: five lines, one per group of beats --------------------------
  buildLines() {
    const evs = this.startupEvents;
    const of = (t) => evs.filter(e => e.type === t);
    const wires = (methods) => evs.filter(e => e.type === "WireMessage" && methods.includes(e.method));
    const cfg = of("ConfigLoaded")[0];
    const hs = of("Handshake");
    const disc = of("ToolsDiscovered");
    const menu = of("MenuBuilt")[0];

    // Heads are short; the full detail (JSON and raw JSON-RPC) is one click away.
    const serverList = (cfg ? cfg.servers : []).map(s => `${s.name} (${s.kind})`).join(", ");
    const protocols = [...new Set(hs.map(e => e.protocol_version))].join(", ");
    const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    this.lines = [
      { family: "neutral", label: "config", head: `${cfg ? cfg.servers.length : 0} servers: ${serverList}`, detail: () => pretty(cfg) },
      { family: "mcp", label: "connected", head: of("ServerConnected").map(e => e.server).join(", "), detail: () => pretty(of("ServerConnected")) },
      { family: "mcp", label: "handshake", head: `${hs.length} servers · protocol ${protocols} via ${hs[0] ? hs[0].handshake : "-"}`, detail: () => this.wireDetail(hs, wires(["server/discover", "response", "error"]), ["server/discover"]) },
      { family: "mcp", label: "discovered", head: disc.map(e => `${e.server}: ${count(e.tool_names.length, "tool")}` + (e.resource_uris.length ? `, ${count(e.resource_uris.length, "resource")}` : "") + (e.prompt_names.length ? `, ${count(e.prompt_names.length, "prompt")}` : "")).join(" · "), detail: () => this.wireDetail(disc, wires(["tools/list", "resources/list", "prompts/list", "response", "error"]), ["tools/list", "resources/list", "prompts/list"]) },
      { family: "neutral", label: "menu", head: menu ? `offered ${menu.offered.length}, blocked ${menu.blocked.length}` + (menu.blocked.length ? `: ${menu.blocked.map(b => b.name).join(", ")}` : "") : "", detail: () => pretty(menu) },
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
    const head = el("span");
    head.appendChild(document.createTextNode(w.direction === "->" ? "host" : w.server));
    head.appendChild(el("span", "flow", "→"));
    head.appendChild(document.createTextNode((w.direction === "->" ? w.server : "host") + "  " + w.method + "  "
      + w.json.slice(0, WIRE_PREVIEW) + (w.json.length > WIRE_PREVIEW ? " …" : "")));
    const r = row("mcp", "wire", head, () => pretty(w.json));
    r.classList.add("wire-row");
    return r;
  },

  // Startup beats from the startup events. Each of the five lines is revealed
  // on the last beat of its event type (connected after the third
  // ServerConnected, and so on), so the lines and the strip stay in step.
  buildStartupSteps() {
    const lineOf = { ConfigLoaded: 0, ServerConnected: 1, Handshake: 2, ToolsDiscovered: 3, MenuBuilt: 4 };
    const steps = FlowState.stepsFrom(this.startupEvents);
    this.startupSteps = steps.map((s, i) => {
      const last = i === steps.length - 1 || steps[i + 1].type !== s.type;
      const opens = i === 0 || steps[i - 1].state.process !== s.state.process;
      return { kind: s.type, seq: s.seq, arrivedAt: 0, rows: [], state: s.state, half: null, wire: null, number: i + 1,
        revealLine: last && s.type in lineOf ? lineOf[s.type] : null,
        weight: (s.state.focus ? FOCUS_WEIGHT : 1) + (opens ? CARD_WEIGHT : 0) };
    });
    // After the strip's startup beats, the live state (turns already in the
    // history) is what the strip should show.
    this.flowState = steps.length ? steps[steps.length - 1].state : this.flowState;
  },

  replay() {
    this.reveal.end();
    const holder = document.getElementById("startup-lines");
    holder.textContent = "";
    this.lineRows = this.lines.map((line) => {
      const r = row(line.family, line.label, line.head, line.detail);
      r.classList.add("unrevealed");
      holder.appendChild(r);
      return r;
    });
    document.getElementById("startup").classList.remove("collapsed");
    if (typeof App !== "undefined") App.syncStartupToggle();
    if (!this.startupSteps.length) return;
    for (const s of this.startupSteps) s.rows = s.revealLine === null ? [] : [this.lineRows[s.revealLine]];
    const last = this.startupSteps[this.startupSteps.length - 1];
    this.sequenceBase = FlowState.initialState();
    this.announced = null;   // every process gets its title card again
    this.reveal.begin(false);
    this.replayTotal = this.startupSteps.length;
    this.reveal.onRevealed((s) => s === last, () => this.showLiveState());
    this.awaitFirstKey("Startup");
    for (const s of this.startupSteps) this.reveal.add(s);
  },

  // In Manual a replay shows nothing until the first key; say so on the strip.
  awaitFirstKey(label) {
    if (this.reveal.mode === "manual") FlowStrip.apply(this.sequenceBase, `${label}: press Right for step 1`);
  },

  replayTurn() {
    if (!this.turnSteps.length) { FlowStrip.apply(this.flowState, "No turn to replay yet"); return; }
    this.reveal.end();
    for (const s of this.turnSteps) this.hideRows(s);
    this.replayTotal = this.turnSteps.length;
    this.sequenceBase = this.turnBase || FlowState.initialState();
    this.reveal.begin(false);
    this.awaitFirstKey("Replay turn");
    for (const s of this.turnSteps) this.reveal.add(s);
  },
  hideRows(step) {
    for (const n of step.rows) n.classList.add("unrevealed");
    if (step.half) for (const n of step.half.rows) n.classList.add("unrevealed");
  },

  // Once a startup replay ends, the strip shows what is live now.
  showLiveState() {
    if (this.flowState && this.flowState.phase === "turn") FlowStrip.apply(this.flowState, FlowState.captionText(this.flowState));
  },

  collapseStartup() {
    document.getElementById("startup").classList.add("collapsed");
    if (typeof App !== "undefined") App.syncStartupToggle();
  },

  // ---- turns --------------------------------------------------------------
  newTurn(ev) {
    if (this.turnCount === 0) this.collapseStartup();
    this.turnCount += 1;
    const sec = el("section", "turn unrevealed");
    const title = el("div", "turn-title", `TURN ${this.turnCount}  `);
    const q = el("span", "q", JSON.stringify(ev.text.length > 70 ? ev.text.slice(0, 70) + "…" : ev.text));
    title.appendChild(q);
    if (ev.note) title.appendChild(el("span", "q", `  (${ev.note})`));
    sec.appendChild(title);
    document.getElementById("turns").appendChild(sec);
    this.currentTurn = sec;
    this.rowsBuilt.push(sec);   // the section shows with its first beat
  },

  rowInto(node) {
    if (!this.currentTurn) {
      // Events without a TurnStarted (e.g. a page loaded mid-turn before the
      // first event, or wire traffic outside a turn) still need a home.
      this.newTurn({ text: "(events before the first turn marker)", note: "" });
      this.currentTurn.classList.remove("unrevealed");
    }
    node.classList.add("unrevealed");
    const pending = this.currentTurn.querySelector(".pending");
    this.currentTurn.insertBefore(node, pending);  // rows go above the dots
    this.rowsBuilt.push(node);
  },

  onTurnStarted(ev) { this.newTurn(ev); },

  onModelCalled(ev) {
    const simulated = this.pendingSimulated; this.pendingSimulated = false;
    const head = `call ${ev.call_number}/${ev.max_calls} · ${ev.elapsed_seconds} s · ${fmtInt(ev.input_tokens)} in / ${fmtInt(ev.output_tokens)} out · stop: ${ev.stop_reason}` + (simulated ? " · synthetic, no API call" : "");
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
    // Allowed: the name and the scope word are enough. Denied: the whole reason.
    const scope = (ev.reason.match(/\((\w+)\)/) || [])[1];
    const head = ev.allowed ? `${ev.name}${scope ? ` (${scope})` : ""}` : `${ev.name}: ${ev.reason}`;
    this.rowInto(row(ev.allowed ? "neutral" : "denied", ev.allowed ? "policy allowed" : "policy DENIED", head, ev.allowed ? () => pretty(ev) : null));
  },

  onWireMessage(ev) { this.rowInto(this.wireRow(ev)); },

  onToolReturned(ev) {
    const family = ev.is_error ? "denied" : "mcp";
    const head = `${ev.name} · ${ev.is_error ? "ERROR" : "ok"} · ${fmtInt(ev.text.length)} chars`;
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
      b.appendChild(el("small", "", `Synthetic reply: ${ev.tool}(${JSON.stringify(ev.args)}). Policy, the tools/call and the next Claude call are real.`));
      this.rowInto(b);
    } else {
      this.rowInto(row("neutral", "simulation", ev.note, null));
    }
  },

  onReset(ev) {
    // Clears the turns only. The controller is reset by handle() for a live
    // Reset; a Reset in the history must not cut the startup replay short.
    document.getElementById("turns").textContent = "";
    this.currentTurn = null;
    this.currentRows = [];
    this.turnCount = 0;
    this.turnSteps = [];
    this.turnOpen = false;
    this.pendingSimulated = false;
    document.getElementById("startup").classList.remove("collapsed");
    if (typeof App !== "undefined") App.syncStartupToggle();
    if (typeof App !== "undefined") App.setFooled(ev.fooled);
  },

  // The current row, fully visible below the sticky strip: #panel has
  // scroll-padding-top equal to the strip's height (set by app.js).
  scrollToCurrent() {
    if (this.scrollTarget) this.scrollTarget.scrollIntoView({ block: "nearest" });
  },
};
