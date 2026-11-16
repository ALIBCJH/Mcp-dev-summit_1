// The flow strip: one SVG built from FLOW, repainted from a FlowState state.
// Nothing here decides what a state means (flow_state.js) or when a state
// is shown (reveal.js). This file draws, animates and runs the Claude
// seconds counter.
"use strict";

const NS = "http://www.w3.org/2000/svg";
const TOOLS_GAP = 12;        // viewBox units between a server box and its tool names
const TOOLS_LINE = 22;       // line height of the tool list
const TOOLS_BASELINE = 7;    // baseline offset that centres one line on the box
const TYPE_MS = { head: 420, info: 260, json: 85 };   // how long the terminal takes per line of each kind
const PIPE_MS = 2800;        // screen one of a beat: the packet in the pipe; then screen two, the terminal
const CARD_MS = 2600;        // how long a process title card holds before the process's animation starts

const FlowStrip = {
  svg: null,
  focusSvg: null,           // the focus stage, shown instead of the overview while state.focus is set
  focusParts: {},
  parts: { nodes: {}, edges: {}, groups: {} },   // groups: the host container and the MCP band
  edgeEnds: {},                                  // edge id -> [from node id, to node id]
  captionEl: null,
  hidden: false,
  current: null,            // the state on screen
  waitingSince: null,       // ms timestamp when Claude started waiting
  counterTimer: null,

  // ---- build -------------------------------------------------------------
  build(holder, captionEl) {
    this.captionEl = captionEl;
    const [x0, y0, w, h] = FLOW.viewBox;
    const svg = svgEl("svg", { viewBox: `${x0} ${y0} ${w} ${h}`, class: "flow-svg", role: "img", "aria-label": "Flow of events between traveller, Claude, host and MCP servers" });
    const byId = {};
    for (const n of FLOW.nodes) byId[n.id] = n;

    for (const c of FLOW.containers) {
      const m = c.members.map((id) => byId[id]);
      const x = Math.min(...m.map((n) => n.x - n.w / 2)) - c.pad, y = Math.min(...m.map((n) => n.y - n.h / 2)) - c.pad;
      const x2 = Math.max(...m.map((n) => n.x + n.w / 2)) + c.pad, y2 = Math.max(...m.map((n) => n.y + n.h / 2)) + c.pad;
      const g = svgEl("g", { class: "group container-g", "data-id": c.id });
      g.appendChild(svgEl("rect", { x, y, width: x2 - x, height: y2 - y, rx: 10, class: "container" }));
      // Bottom-left: the top edge is where the members' status words sit.
      g.appendChild(svgText(x + 10, y2 - 9, c.label, "container-label"));
      svg.appendChild(g);
      this.parts.groups[c.id] = { g };
    }
    const b = FLOW.band;
    const bg = svgEl("g", { class: "group band-g", "data-id": b.id });
    bg.appendChild(svgEl("rect", { x: b.x, y: 8, width: b.w, height: h - 16, rx: 8, class: "band" }));
    const bl = svgText(b.x + b.w / 2, h / 2, b.label, "band-label");
    bl.setAttribute("transform", `rotate(-90 ${b.x + b.w / 2} ${h / 2})`);
    bg.appendChild(bl);
    svg.appendChild(bg);
    this.parts.groups[b.id] = { g: bg };

    for (const e of FLOW.edges) {
      const from = byId[e.from], to = byId[e.to];
      const [p1, p2] = anchors(from, to);
      const g = svgEl("g", { class: `edge ${e.family} idle`, "data-id": e.id });
      g.appendChild(svgEl("path", { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, class: "line" }));
      g.appendChild(arrowHead(p1, p2));
      if (e.arrows === "both") g.appendChild(arrowHead(p2, p1));
      svg.appendChild(g);
      this.parts.edges[e.id] = { g };
      this.edgeEnds[e.id] = [e.from, e.to];
    }

    for (const n of FLOW.nodes) {
      const g = svgEl("g", { class: `node ${n.family} idle`, "data-id": n.id });
      g.appendChild(svgEl("rect", { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 9, class: "box" }));
      g.appendChild(svgText(n.x, n.y - (n.sub ? 4 : -1), n.label, "label"));
      if (n.sub) g.appendChild(svgText(n.x, n.y + 16, n.sub, "sub"));
      g.appendChild(svgText(n.x, n.y - n.h / 2 - 7, "", "status"));
      // Tool names sit to the right of a server box, one per line, so they
      // can be large without running into the next server.
      const tools = svgText(n.x + n.w / 2 + TOOLS_GAP, n.y, "", "tools");
      tools.setAttribute("text-anchor", "start");
      g.appendChild(tools);
      svg.appendChild(g);
      this.parts.nodes[n.id] = { g, status: g.querySelector(".status"), tools };
    }
    holder.appendChild(svg);
    this.svg = svg;
    this.buildFocus(holder, w, h);
    this.buildProcessStrip();
    try { this.setHidden(localStorage.getItem("strip") === "hidden"); } catch (e) { /* ignore */ }
  },

  // The chips strip: the four processes in order, lit as the story reaches them.
  buildProcessStrip() {
    const strip = document.getElementById("process-strip");
    strip.textContent = "";
    this.chips = {};
    FlowState.PROCESSES.forEach((p, i) => {
      const chip = document.createElement("span");
      chip.className = "chip todo";
      chip.innerHTML = `<span class="chip-n">${i + 1}</span><span class="chip-name"></span>`;
      chip.querySelector(".chip-name").textContent = p.name;
      strip.appendChild(chip);
      this.chips[p.id] = chip;
    });
    this.mark = document.getElementById("process-mark");
    this.card = document.getElementById("process-card");
    this.cardTimer = null;
  },
  paintProcess(state) {
    const current = state.process, allDone = state.phase === "turn" || current === null && state.stepNumber > 0;
    const idx = current ? FlowState.processIndex(current) : -1;
    for (const p of FlowState.PROCESSES) {
      const i = FlowState.processIndex(p.id);
      const cls = allDone || i < idx ? "done" : i === idx ? "current" : "todo";
      this.chips[p.id].className = `chip ${cls}`;
    }
    const proc = FlowState.processOf(state);
    this.mark.textContent = proc ? proc.name : "";
  },
  // The title card: "Process 2 of 4 · Handshake", then `then()` runs the
  // beat's own animation. A card still up when the next arrives yields to it.
  announce(proc, then) {
    if (this.cardTimer) { clearTimeout(this.cardTimer); this.cardTimer = null; if (this.cardThen) this.cardThen(); }
    const card = this.card, n = FlowState.processIndex(proc.id) + 1;
    card.querySelector(".card-kicker").textContent = `Process ${n} of ${FlowState.PROCESSES.length}`;
    card.querySelector(".card-name").textContent = proc.name;
    card.querySelector(".card-blurb").textContent = proc.blurb;
    card.hidden = false;
    card.classList.remove("leaving", "enter"); void card.offsetWidth; card.classList.add("enter");
    this.cardThen = then;
    this.cardTimer = setTimeout(() => {
      this.cardTimer = null; this.cardThen = null;
      card.classList.add("leaving");
      setTimeout(() => { card.hidden = true; card.classList.remove("leaving"); }, 500);
      then();
    }, CARD_MS);
  },

  // The focus stage: Host, the MCP band and one server, with a story line
  // under them. Labels are filled in per connection by paintFocus.
  buildFocus(holder, w, h) {
    const F = FLOW.focusStage;
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "flow-svg focus-svg", role: "img", "aria-label": "One MCP connection, large" });
    svg.classList.add("off");   // SVG elements have no `hidden` property, so a class does it
    const stage = svgEl("g", { class: "stage" });   // screen one: the pipe diagram, grouped so it fades as one
    const box = (n, family) => {
      const g = svgEl("g", { class: `node ${family} active` });
      g.appendChild(svgEl("rect", { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 14, class: "box" }));
      const label = svgText(n.x, n.y - 6, "", "label"), sub = svgText(n.x, n.y + 26, "", "sub"), status = svgText(n.x, n.y - n.h / 2 - 12, "", "status");
      g.appendChild(label); g.appendChild(sub); g.appendChild(status);
      stage.appendChild(g);
      return { g, label, sub, status };
    };
    const title = svgText(F.marginX, F.titleY, "", "title"); title.setAttribute("text-anchor", "start"); svg.appendChild(title);
    svg.appendChild(stage);
    const band = svgEl("g", { class: "group band-g" });
    band.appendChild(svgEl("rect", { x: F.band.x - F.band.w / 2, y: F.host.y - F.host.h / 2 - 30, width: F.band.w, height: F.host.h + 60, rx: 10, class: "band" }));
    const bl = svgText(F.band.x, F.host.y, FLOW.band.label, "band-label");
    bl.setAttribute("transform", `rotate(-90 ${F.band.x} ${F.host.y})`);
    band.appendChild(bl);
    stage.appendChild(band);
    const p1 = { x: F.host.x + F.host.w / 2, y: F.host.y }, p2 = { x: F.server.x - F.server.w / 2, y: F.server.y };
    const edge = svgEl("g", { class: "edge mcp idle" });
    edge.appendChild(svgEl("path", { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, class: "line" }));
    edge.appendChild(arrowHead(p1, p2));
    edge.appendChild(arrowHead(p2, p1));
    stage.appendChild(edge);
    const host = box(F.host, "neutral"), server = box(F.server, "mcp");
    // The packet: a chip that travels the line carrying the JSON-RPC method.
    const K = F.packet;
    const packet = svgEl("g", { class: "packet" });
    packet.appendChild(svgEl("rect", { x: K.from - K.w / 2, y: K.y - K.h / 2, width: K.w, height: K.h, rx: 20, class: "chip" }));
    packet.appendChild(svgText(K.from, K.y + 7, "", "chip-text"));
    stage.appendChild(packet);
    holder.appendChild(svg);
    this.focusSvg = svg;
    // Screen two lives outside the SVG: #wire-screen covers the whole kernel panel.
    this.wireScreen = document.getElementById("wire-screen");
    this.focusParts = { title, host, server, edge, packet, stage, term: document.getElementById("wire-term"),
      wireTitle: document.getElementById("wire-title"), wireCaption: document.getElementById("wire-caption") };
    this.typer = { timer: null, queue: [] };
    this.phaseTimer = null;
  },

  // ---- paint -----------------------------------------------------------------
  // since: ms timestamp (Date.now) when Claude really started waiting, so a
  // step revealed late still shows the true elapsed time.
  apply(state, captionText, since) {
    this.current = state;
    const built = state.built || [];
    const has = (id) => built.includes(id);
    for (const [id, part] of Object.entries(this.parts.nodes)) {
      const ns = state.nodes[id] || { status: "idle", label: "" };
      part.g.setAttribute("class", `node ${familyOf(id)} ${ns.status} ${buildClass(part, has(id))}`);
      part.status.textContent = ns.label || "";
      const srv = state.servers[id];
      if (srv) this.paintTools(part.tools, srv);
    }
    for (const [id, part] of Object.entries(this.parts.edges)) {
      const [from, to] = this.edgeEnds[id];
      part.g.setAttribute("class", `edge ${edgeFamily(id)} ${state.edges[id] || "idle"} ${buildClass(part, has(from) && has(to))}`);
    }
    for (const [id, part] of Object.entries(this.parts.groups)) {
      part.g.setAttribute("class", `group ${id === FLOW.band.id ? "band-g" : "container-g"} ${buildClass(part, has(id))}`);
    }
    this.paintProcess(state);
    this.paintFocus(state.focus || null);
    if (this.captionEl && captionText !== undefined) {
      this.captionEl.textContent = captionText;
      if (this.focusParts.wireCaption) this.focusParts.wireCaption.textContent = captionText;
    }
    this.runCounter(state, since);
  },

  // Show the focus stage for one connection, or the overview when focus is null.
  // A new connection enters with a short animation; its handshake beat does not.
  paintFocus(focus) {
    if (this.focusSvg) this.focusSvg.classList.toggle("off", !focus);
    this.svg.classList.toggle("off", !!focus);
    if (!focus) { this.focusShown = null; this.beatShown = null; this.stopPhase(); return; }
    const P = this.focusParts, label = nodeLabelOf(focus.id);
    if (this.focusShown !== focus.id) {
      this.focusShown = focus.id;
      this.focusSvg.classList.remove("enter"); void this.focusSvg.getBoundingClientRect(); this.focusSvg.classList.add("enter");
    }
    P.host.label.textContent = "Host"; P.host.sub.textContent = "agent loop · policy";
    P.server.label.textContent = label; P.server.sub.textContent = focus.transport;
    const beat = `${focus.id}:${focus.stage}`;
    if (beat === this.beatShown) return;   // the same beat painted again: leave its sequence alone
    this.beatShown = beat;
    const req = focus.request, res = focus.response;
    if (focus.stage === "connected") {
      P.host.status.textContent = req ? `sends ${req.method}` : "connecting"; P.server.status.textContent = "connected";
      P.edge.setAttribute("class", "edge mcp fwd");
    } else {
      P.host.status.textContent = `protocol ${focus.protocol}`; P.server.status.textContent = `answers ${focus.handshake}`;
      P.edge.setAttribute("class", "edge mcp back");
    }
    // A new chapter, or a step back to a chapter's first beat, starts the
    // terminal from a clean screen; the reply beat appends to it.
    const fresh = this.termChapter !== focus.id || focus.stage === "connected";
    this.termChapter = focus.id;
    const lines = [];
    if (fresh) lines.push(...connectLines(focus, label));
    if (focus.stage === "handshake") lines.push(...handshakeLines(focus, label));
    this.runBeat({
      title: `Handshake ${focus.number} of ${focus.total}: Host to ${label}`,
      packet: focus.stage === "connected" ? [req ? req.method : "connect", "right"] : [res ? res.method : "reply", "left"],
      fresh, lines,
    });
  },

  // One beat is two screens: the pipe with the packet travelling (PIPE_MS),
  // then the diagram fades out and the terminal fills the stage and types.
  runBeat(beat) {
    this.stopPhase();
    const P = this.focusParts;
    if (beat.fresh) this.clearTerminal();
    P.title.textContent = beat.title;
    this.focusSvg.classList.remove("wire");
    this.sendPacket(beat.packet[0], beat.packet[1]);
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      this.focusSvg.classList.add("wire");
      this.showWireScreen(`${beat.title} · on the wire`);
      this.typeLines(beat.lines);
    }, PIPE_MS);
  },
  stopPhase() {
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
    if (this.focusSvg) this.focusSvg.classList.remove("wire");
    if (this.wireScreen) this.wireScreen.hidden = true;
  },
  // The wire screen covers the kernel panel (everything under the toolbar).
  showWireScreen(title) {
    const screen = this.wireScreen;
    screen.style.top = `${document.getElementById("panel").offsetTop}px`;
    this.focusParts.wireTitle.textContent = title;
    this.focusParts.wireCaption.textContent = this.captionEl ? this.captionEl.textContent : "";
    screen.hidden = false;
    screen.classList.remove("enter"); void screen.offsetWidth; screen.classList.add("enter");
  },

  // ---- the wire terminal ------------------------------------------------------
  clearTerminal() {
    if (this.typer.timer) { clearTimeout(this.typer.timer); this.typer.timer = null; }
    this.typer.queue = [];
    this.focusParts.term.textContent = "";
  },
  // Lines appear one at a time, like a log being written, the newest at the
  // bottom with a cursor; the screen scrolls so the newest line stays in view.
  typeLines(lines) {
    this.typer.queue.push(...lines);
    if (this.typer.timer) return;
    const tick = () => {
      const line = this.typer.queue.shift();
      if (!line) { this.typer.timer = null; return; }
      const body = this.focusParts.term;
      const prev = body.lastElementChild; if (prev) prev.classList.remove("typing");
      const el = document.createElement("div"); el.setAttribute("class", `tl ${line.kind} typing`);
      for (const [cls, text] of line.spans) { const s = document.createElement("span"); if (cls) s.setAttribute("class", cls); s.textContent = text; el.appendChild(s); }
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.typer.timer = setTimeout(tick, reduced ? 0 : TYPE_MS[line.kind] || 100);
    };
    tick();
  },

  // Start the packet travelling along the line, right (host to server) or left.
  sendPacket(text, dir) {
    const g = this.focusParts.packet;
    g.querySelector(".chip-text").textContent = text;
    g.setAttribute("class", "packet");
    void g.getBoundingClientRect();   // restart the animation
    g.setAttribute("class", `packet go-${dir}`);
  },

  // One line per tool, centred on the box; a blocked tool takes a second
  // line for the word "(blocked)" so the name itself stays readable.
  paintTools(text, srv) {
    text.textContent = "";
    const names = srv.tools.length ? srv.tools : (srv.stage ? [srv.stage] : []);
    const lines = [];
    for (const name of names) {
      const blocked = srv.blocked.includes(name);
      lines.push({ text: name, cls: blocked ? "blocked" : "" });
      if (blocked) lines.push({ text: "(blocked)", cls: "blocked-note" });
    }
    const x = text.getAttribute("x"), y = Number(text.getAttribute("y"));
    const top = y - ((lines.length - 1) * TOOLS_LINE) / 2 + TOOLS_BASELINE;
    lines.forEach((line, i) => {
      const t = svgEl("tspan", { x, y: top + i * TOOLS_LINE, class: line.cls });
      t.textContent = line.text;
      text.appendChild(t);
    });
  },

  // Claude is "waiting" between the moment the loop needs it and ModelCalled.
  // The exact seconds arrive with ModelCalled; until then a counter runs.
  runCounter(state, since) {
    const waiting = state.nodes.claude && state.nodes.claude.status === "waiting";
    if (!waiting) { this.stopCounter(); return; }
    if (this.counterTimer) return;
    this.waitingSince = since || Date.now();
    const part = this.parts.nodes.claude;
    this.counterTimer = setInterval(() => {
      part.status.textContent = `${((Date.now() - this.waitingSince) / 1000).toFixed(1)} s…`;
    }, 100);
  },
  stopCounter() { if (this.counterTimer) { clearInterval(this.counterTimer); this.counterTimer = null; } },

  // ---- visibility (key D) -------------------------------------------------
  setHidden(on) {
    this.hidden = on;
    document.getElementById("strip").classList.toggle("hidden", on);
    try { localStorage.setItem("strip", on ? "hidden" : "shown"); } catch (e) { /* ignore */ }
    if (typeof App !== "undefined" && App.syncFlowToggle) App.syncFlowToggle();
  },
  toggle() { this.setHidden(!this.hidden); },
};

// ---- geometry helpers ---------------------------------------------------------

function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}
function svgText(x, y, text, cls) {
  const t = svgEl("text", { x, y, class: cls, "text-anchor": "middle" });
  t.textContent = text;
  return t;
}
// A part is "unbuilt" (invisible) or "building" (plays its entrance once).
// The class sticks while the part stays built, so later repaints never replay
// the entrance; it goes back to unbuilt only when the stage is cleared.
function buildClass(part, builtNow) {
  part.build = builtNow ? "building" : "unbuilt";
  return part.build;
}
// ---- terminal lines: { kind, spans: [[cls, text], ...] } ---------------------
// Startup events carry no clock, so the log keys lines on nothing invented:
// direction, peers, method and the message id from the JSON itself.
function connectLines(focus, label) {
  const srv = focus.id, req = focus.request;
  const out = [{ kind: "info", spans: [["dim", "# "], ["", `${focus.number}. host starts ${label} over ${focus.transport}`]] },
    { kind: "info", spans: [["ok", "✓ "], ["", `${srv} connected`]] }];
  if (req) {
    out.push({ kind: "head", spans: [["dir out", "→ "], ["peer", `host → ${srv}`], ["dim", "  "], ["method", req.method], ["dim", `  id=${idOf(req.json)}`]] });
    out.push(...jsonLines(req.json));
  }
  return out;
}
function handshakeLines(focus, label) {
  const srv = focus.id, res = focus.response;
  const out = [];
  if (res) {
    out.push({ kind: "head", spans: [["dir in", "← "], ["peer", `${srv} → host`], ["dim", "  "], ["method", res.method], ["dim", `  id=${idOf(res.json)}`]] });
    out.push(...jsonLines(res.json));
  }
  out.push({ kind: "info", spans: [["ok", "✓ "], ["", `${label} answers ${focus.handshake}: protocol ${focus.protocol} · ${focus.capabilities.join(", ")}`]] });
  return out;
}
function idOf(json) { try { const v = JSON.parse(json).id; return v === undefined ? "-" : v; } catch (e) { return "-"; } }

// Pretty-printed JSON, one terminal line per text line, tokens classed for
// colour: keys, strings, numbers, booleans/null, punctuation. Text that is
// not JSON comes back as one plain line.
function jsonLines(json) {
  let pretty;
  try { pretty = JSON.stringify(JSON.parse(json), null, 2); } catch (e) { return [{ kind: "json", spans: [["", json]] }]; }
  return pretty.split("\n").map((text) => ({ kind: "json", spans: tokenise(text) }));
}
function tokenise(text) {
  const spans = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|(true|false|null)|([{}\[\],:])|(\s+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) { spans.push([m[2] ? "key" : "str", m[1]]); if (m[2]) spans.push(["punc", m[2]]); }
    else if (m[3] !== undefined) spans.push(["num", m[3]]);
    else if (m[4] !== undefined) spans.push(["lit", m[4]]);
    else if (m[5] !== undefined) spans.push(["punc", m[5]]);
    else spans.push(["", m[6]]);
  }
  return spans;
}
function nodeLabelOf(id) { const n = FLOW.nodes.find((x) => x.id === id); return n ? n.label : id; }
function familyOf(id) { return FLOW.nodes.find((n) => n.id === id).family; }
function edgeFamily(id) { return FLOW.edges.find((e) => e.id === id).family; }

// Edge endpoints on the box borders, so the arrowheads touch the boxes.
function anchors(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const p1 = clipToBox(a, dx, dy), p2 = clipToBox(b, -dx, -dy);
  return [p1, p2];
}
function clipToBox(n, dx, dy) {
  const hw = n.w / 2 + 4, hh = n.h / 2 + 4;
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx), sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: n.x + dx * s, y: n.y + dy * s };
}
function arrowHead(from, to) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x), size = 11;
  const p = (a, d) => `${to.x - d * Math.cos(a)},${to.y - d * Math.sin(a)}`;
  const left = `${to.x - size * Math.cos(ang - 0.45)},${to.y - size * Math.sin(ang - 0.45)}`;
  const right = `${to.x - size * Math.cos(ang + 0.45)},${to.y - size * Math.sin(ang + 0.45)}`;
  return svgEl("polygon", { points: `${to.x},${to.y} ${left} ${right}`, class: "head" });
}

if (typeof module !== "undefined") module.exports = { jsonLines, tokenise, connectLines, handshakeLines };
