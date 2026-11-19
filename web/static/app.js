// Wires the page to the server: SSE in, POSTs out, buttons, theme.
"use strict";

const SPOT_MS = 1800;   // how long the shell and kernel labels pulse before the shell is pushed left

const EVENT_TYPES = ["ConfigLoaded", "ServerConnected", "Handshake", "ToolsDiscovered", "MenuBuilt", "WireMessage",
  "TurnStarted", "ModelCalled", "ToolRequested", "PolicyDecided", "ToolReturned", "FinalAnswer", "TurnFailed",
  "SimulatedReply", "Reset"];

const App = {
  lastSeq: 0,
  seen: new Set(),   // dedupe by seq: history and live can only overlap on a reconnect
  source: null,
  busy: false,

  connect() {
    if (this.source) this.source.close();
    const src = new EventSource(`/api/events?after=${this.lastSeq}`);
    for (const t of EVENT_TYPES) src.addEventListener(t, (e) => this.receive(JSON.parse(e.data)));
    src.onopen = () => this.conn("live", "connected");
    src.onerror = () => this.conn("down", "reconnecting…");
    this.source = src;
  },

  receive(ev) {
    if (this.seen.has(ev.seq)) return;
    this.seen.add(ev.seq);
    if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    if (ev.type === "FinalAnswer" || ev.type === "TurnFailed") Panel.stats.finalArrivedAt = performance.now();
    Panel.handle(ev);
  },

  conn(state, title) {
    const n = document.getElementById("conn-state");
    n.textContent = state === "live" ? "●" : "○ " + title;
    n.title = title;
  },

  async loadState() {
    const s = await (await fetch("/api/state")).json();
    // Model name only; the thinking/effort settings sit in the tooltip.
    const m = document.getElementById("model-line");
    m.textContent = s.model; m.title = s.settings;
    this.setFooled(s.fooled);
    this.setBusy(s.turn_running);
    // Everything up to here already happened: show it at once, pace only what comes next.
    Panel.instantUntil = s.last_seq;
  },

  lastTimedPace: Reveal.DEFAULT_PACE,   // what the Step box goes back to when unticked

  // One pace for everything: live turns, Replay turn and Replay startup.
  setPace(mode) {
    if (!(mode in Reveal.PACE_MS)) mode = Reveal.DEFAULT_PACE;   // old or odd saved values
    Panel.reveal.setMode(mode);
    if (mode !== "manual") this.lastTimedPace = mode;
    document.getElementById("pace").value = mode;
    document.getElementById("step-mode").checked = mode === "manual";
    document.getElementById("pace-state").textContent = `pace: ${Reveal.PACE_LABEL[mode].split(" ")[0]}`;
    this.updateHint(Panel.reveal.counter(), mode);
    try { localStorage.setItem("pace", mode); } catch (e) { /* ignore */ }
  },

  updateHint(counter, mode) {
    const hint = document.getElementById("step-hint");
    hint.textContent = Reveal.hintText(counter, mode);
    hint.hidden = mode !== "manual";
  },

  setFooled(on) {
    const badge = document.getElementById("fooled-state");
    badge.textContent = "fooled LLM ON";
    badge.className = "badge denied";
    badge.hidden = !on;   // nothing to say while it is off
    document.getElementById("fooled-toggle").checked = on;
  },

  setBusy(on) {
    this.busy = on;
    document.getElementById("send-btn").disabled = on;
    for (const b of document.querySelectorAll(".quick button")) b.disabled = on;
  },

  chatLine(cls, who, text, markdown) {
    const log = document.getElementById("chat-log");
    const m = el("div", "msg " + cls);
    if (who) m.appendChild(el("span", "who", who));
    // Assistant text is rendered as limited markdown; renderMarkdown escapes
    // everything first and only emits p, br, strong, em, code, ul, li.
    if (markdown) m.insertAdjacentHTML("beforeend", renderMarkdown(text));
    else m.appendChild(document.createTextNode(text));
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  },

  async send(text) {
    if (!text.trim()) return;
    Panel.flush();   // the previous turn's unrevealed steps, and a held answer, show now
    this.chatLine("you", "you>", text);
    this.setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok) { this.chatLine("error", "", `${res.status}: ${data.error}`); return; }
      if (data.note && data.answer === null) { this.chatLine("note", "", data.note); return; }
      if (data.note) this.chatLine("note", "", data.note + " → sent as the message above");
      // With Hold answer on, the bubble waits for the "Claude answers" step.
      Panel.whenAnswerShown(() => this.chatLine("assistant", "assistant>", data.answer, true));
    } catch (err) {
      this.chatLine("error", "", `request failed: ${err}`);
    } finally {
      this.setBusy(false);   // the server turn is over; the reveal may still be running
    }
  },

  async post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (!res.ok) this.chatLine("error", "", `${res.status}: ${data.error}`);
    return res.ok ? data : null;
  },

  // The theme is not remembered: every load is light, so the page on the
  // projector always looks the same. Dark is a toggle for the session only.
  theme(name) {
    document.documentElement.dataset.theme = name;
    document.getElementById("theme-toggle").textContent = name === "dark" ? "Light" : "Dark";
  },

  // A toggle bar's caret, switch and word follow its aria-expanded state.
  paintToggle(id, open, word) {
    const bar = document.getElementById(id);
    bar.setAttribute("aria-expanded", String(open));
    bar.querySelector(".toggle-word").textContent = open ? "hide" : word;
  },

  // The STARTUP bar follows the section's collapsed class (panel.js also
  // collapses and expands it as turns come and go).
  syncStartupToggle() {
    const open = !document.getElementById("startup").classList.contains("collapsed");
    const n = document.querySelectorAll("#startup-lines > .row").length;
    this.paintToggle("startup-title", open, `show ${n ? n + " lines" : ""}`.trim());
  },

  // The FLOW bar hides the strip (same as key D); the log then takes the
  // whole kernel. FlowStrip remembers the choice and calls back here.
  syncFlowToggle() { this.paintToggle("flow-toggle", !FlowStrip.hidden, "show"); },

  // The LOG bar hides everything under the strip (startup lines and turns);
  // the strip then grows to fill the kernel. The choice survives a reload.
  setLogShown(on) {
    document.getElementById("panel").classList.toggle("log-hidden", !on);
    this.paintToggle("log-toggle", on, "show");
    try { localStorage.setItem("log", on ? "1" : "0"); } catch (e) { /* storage may be blocked */ }
  },

  // After the opening: both labels pulse (the audience sees where the shell
  // and the kernel are), then the shell is pushed to the left and the
  // kernel takes the width. The rail, or this method, brings the shell back.
  spotlightThenDock() {
    document.body.classList.add("spotlight");
    setTimeout(() => { document.body.classList.remove("spotlight"); this.dockShell(true); }, SPOT_MS);
  },
  dockShell(on) {
    document.querySelector(".columns").classList.toggle("shell-docked", on);
    document.getElementById("shell-rail").setAttribute("aria-expanded", String(!on));
    if (!on) document.getElementById("chat-input").focus();
  },

  // ---- presenter notes (N) ----
  showNotes(note) {
    const box = document.getElementById("notes");
    this.lastNote = note;
    if (!note) { box.classList.add("quiet"); return; }
    box.classList.remove("quiet");
    box.querySelector(".notes-title").textContent = note.title;
    const ul = box.querySelector(".notes-lines");
    ul.textContent = "";
    for (const line of note.lines) ul.appendChild(el("li", "", line));
  },
  toggleNotes() {
    const box = document.getElementById("notes");
    box.hidden = !box.hidden;
    if (!box.hidden && !this.lastNote) box.querySelector(".notes-title").textContent = "Notes follow the current beat";
  },

  // ---- the closing card (K) ----
  showClosing() {
    const card = document.getElementById("closing");
    if (!card.hidden) return;
    const ul = card.querySelector(".closing-processes");
    ul.textContent = "";
    for (const p of FlowState.PROCESSES) ul.appendChild(el("li", "", p.name));
    const s = Score.sum(Panel.tallies);
    card.querySelector(".closing-stats").textContent = s.turns
      ? `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${s.modelCalls} Claude call${s.modelCalls === 1 ? "" : "s"} · ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"} · ${s.wire} messages on the wire${s.denied ? ` · ${s.denied} blocked by policy` : ""}`
      : "3 servers · 5 tools · 0 blocked";
    card.hidden = false;
    card.classList.remove("leaving");
    const close = (e) => {
      if (e.type === "keydown" && e.target.tagName === "INPUT") return;
      e.preventDefault(); e.stopPropagation();
      document.removeEventListener("keydown", close, true);
      card.removeEventListener("click", close);
      card.classList.add("leaving");
      setTimeout(() => { card.hidden = true; card.classList.remove("leaving"); }, 500);
    };
    setTimeout(() => { document.addEventListener("keydown", close, true); card.addEventListener("click", close); }, 600);
  },

  // ---- autopilot (A) ----
  runAutopilot() {
    Autopilot.onStatus = (text) => {
      const badge = document.getElementById("auto-state");
      badge.hidden = !text;
      badge.textContent = text ? `autopilot ${text}` : "";
    };
    Autopilot.run({
      prompts: [...document.querySelectorAll(".quick button")].map((b) => b.dataset.send),
      pace: () => Panel.reveal.mode,
      setPace: (m) => this.setPace(m),
      replayStartup: () => new Promise((resolve) => {
        Panel.replay();
        const last = Panel.startupSteps[Panel.startupSteps.length - 1];
        Panel.reveal.onRevealed((s) => s === last, resolve);
      }),
      // Resolves once the answer bubble is on screen (Hold answer waits for the step).
      send: async (text) => { await this.send(text); await new Promise((r) => Panel.whenAnswerShown(r)); },
      closing: () => this.showClosing(),
    });
  },

  init() {
    this.theme("light");
    document.getElementById("theme-toggle").addEventListener("click", () =>
      this.theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input");
      const text = input.value; input.value = "";
      this.send(text);
    });
    for (const b of document.querySelectorAll(".quick button")) b.addEventListener("click", () => this.send(b.dataset.send));

    Panel.init();
    FlowStrip.build(document.getElementById("strip-svg"), document.getElementById("caption"));
    document.getElementById("replay-btn").addEventListener("click", () => Panel.replay());
    document.getElementById("replay-turn-btn").addEventListener("click", () => Panel.replayTurn());
    // Buttons, selects and checkboxes give focus back to the page after use,
    // so Space and the arrows reach the key handler instead of the control.
    document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) b.blur(); });
    document.addEventListener("change", (e) => { if (e.target.matches("select, input[type=checkbox]")) e.target.blur(); });
    let pace = Reveal.DEFAULT_PACE;
    try { pace = localStorage.getItem("pace") || pace; } catch (e) { /* ignore */ }
    this.setPace(pace);
    document.getElementById("pace").addEventListener("change", (e) => this.setPace(e.target.value));
    // The Step box is an alias for Manual; unticking returns to the last timed pace.
    document.getElementById("step-mode").addEventListener("change", (e) => this.setPace(e.target.checked ? "manual" : this.lastTimedPace));
    document.getElementById("hold-answer").addEventListener("change", (e) => Panel.reveal.setHoldAnswer(e.target.checked));
    document.addEventListener("keydown", (e) => {
      const k = Reveal.keyAction(e.key, e.target.tagName);
      if (!k) return;
      if (k.prevent) e.preventDefault();   // no page scroll on Space, arrows, Home, End
      if (k.action === "toggle") FlowStrip.toggle();
      else if (k.action === "autopilot") this.runAutopilot();
      else if (k.action === "closing") this.showClosing();
      else if (k.action === "notes") this.toggleNotes();
      else Panel.reveal.key(k.action);
    });
    // The strip is sticky; rows scrolled into view must land below it.
    const strip = document.getElementById("strip");
    const setStripHeight = () => document.getElementById("panel").style.setProperty("--strip-h", `${strip.getBoundingClientRect().height}px`);
    new ResizeObserver(setStripHeight).observe(strip);
    setStripHeight();
    document.getElementById("reset-btn").addEventListener("click", async () => {
      const data = await this.post("/api/reset");
      if (data) { document.getElementById("chat-log").textContent = ""; this.setFooled(data.fooled); }
    });
    document.getElementById("fooled-toggle").addEventListener("change", async (e) => {
      const data = await this.post("/api/fooled", { on: e.target.checked });
      this.setFooled(data ? data.fooled : !e.target.checked);
    });
    document.getElementById("autopilot-btn").addEventListener("click", () => this.runAutopilot());
    document.getElementById("closing-btn").addEventListener("click", () => this.showClosing());
    document.getElementById("shell-rail").addEventListener("click", () => this.dockShell(false));
    document.getElementById("dock-shell-btn").addEventListener("click", () => this.dockShell(true));
    document.getElementById("flow-toggle").addEventListener("click", () => FlowStrip.toggle());
    this.syncFlowToggle();
    document.getElementById("log-toggle").addEventListener("click", () =>
      this.setLogShown(document.getElementById("panel").classList.contains("log-hidden")));
    let logStored = "1";
    try { logStored = localStorage.getItem("log") || "1"; } catch (e) { /* storage may be blocked */ }
    this.setLogShown(logStored !== "0");
    document.getElementById("startup-title").addEventListener("click", () => {
      document.getElementById("startup").classList.toggle("collapsed");
      this.syncStartupToggle();
    });

    this.loadState().catch(() => {}).then(() => this.connect());
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
