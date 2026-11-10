// Wires the page to the server: SSE in, POSTs out, buttons, theme.
"use strict";

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
    Panel.handle(ev);
  },

  conn(state, title) {
    const n = document.getElementById("conn-state");
    n.textContent = state === "live" ? "● live" : "○ " + title;
    n.title = title;
  },

  async loadState() {
    const s = await (await fetch("/api/state")).json();
    document.getElementById("model-line").textContent = `${s.model}  (${s.settings})`;
    this.setFooled(s.fooled);
    this.setBusy(s.turn_running);
  },

  setFooled(on) {
    const badge = document.getElementById("fooled-state");
    badge.textContent = `fooled LLM: ${on ? "ON" : "off"}`;
    badge.className = "badge " + (on ? "denied" : "neutral");
    document.getElementById("fooled-toggle").checked = on;
  },

  setBusy(on) {
    this.busy = on;
    document.getElementById("send-btn").disabled = on;
    for (const b of document.querySelectorAll(".quick button")) b.disabled = on;
  },

  chatLine(cls, who, text) {
    const log = document.getElementById("chat-log");
    const m = el("div", "msg " + cls);
    if (who) m.appendChild(el("span", "who", who));
    m.appendChild(document.createTextNode(text));
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  },

  async send(text) {
    if (!text.trim()) return;
    this.chatLine("you", "you>", text);
    this.setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok) { this.chatLine("error", "", `${res.status}: ${data.error}`); return; }
      if (data.note && data.answer === null) { this.chatLine("note", "", data.note); return; }
      if (data.note) this.chatLine("note", "", data.note + " → sent as the message above");
      this.chatLine("assistant", "assistant>", data.answer);
    } catch (err) {
      this.chatLine("error", "", `request failed: ${err}`);
    } finally {
      this.setBusy(false);
    }
  },

  async post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (!res.ok) this.chatLine("error", "", `${res.status}: ${data.error}`);
    return res.ok ? data : null;
  },

  theme(name) {
    document.documentElement.dataset.theme = name;
    document.getElementById("theme-toggle").textContent = name === "dark" ? "Light" : "Dark";
    try { localStorage.setItem("theme", name); } catch (e) { /* private window */ }
  },

  init() {
    let saved = "light";
    try { saved = localStorage.getItem("theme") || "light"; } catch (e) { /* ignore */ }
    this.theme(saved);
    document.getElementById("theme-toggle").addEventListener("click", () =>
      this.theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input");
      const text = input.value; input.value = "";
      this.send(text);
    });
    for (const b of document.querySelectorAll(".quick button")) b.addEventListener("click", () => this.send(b.dataset.send));

    document.getElementById("replay-btn").addEventListener("click", () => Panel.replay());
    document.getElementById("step-mode").addEventListener("change", (e) => { Panel.stepMode = e.target.checked; });
    document.addEventListener("keydown", (e) => {
      if (!Panel.stepMode || e.target.tagName === "INPUT") return;
      if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); Panel.revealNext(); }
    });
    document.getElementById("reset-btn").addEventListener("click", async () => {
      const data = await this.post("/api/reset");
      if (data) { document.getElementById("chat-log").textContent = ""; this.setFooled(data.fooled); }
    });
    document.getElementById("fooled-toggle").addEventListener("change", async (e) => {
      const data = await this.post("/api/fooled", { on: e.target.checked });
      this.setFooled(data ? data.fooled : !e.target.checked);
    });
    document.getElementById("startup-title").addEventListener("click", () =>
      document.getElementById("startup").classList.toggle("collapsed"));

    this.loadState();
    this.connect();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
