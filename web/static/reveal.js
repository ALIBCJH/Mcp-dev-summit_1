// The reveal controller: one clock for the strip and the rows.
//
// A sequence (a live turn, Replay turn, Replay startup) is a list of steps.
// Steps are added as events arrive and revealed one dwell apart, or on keys
// in Manual. The dwell applies only between reveals: a step that arrives
// later than one dwell after the last reveal shows at once, so real waiting
// (a model call in flight) is never padded.
//
// No DOM and no real timers in this file. The panel passes a clock, timer
// functions and show/hide callbacks, so every rule here runs in Node.
"use strict";

// Dwell between steps, in milliseconds. null = Manual: keys only.
const PACE_MS = { instant: 0, fast: 600, narrate: 1500, slow: 2500, manual: null };
const PACE_LABEL = { instant: "Instant", fast: "Fast 0.6 s", narrate: "Narrate 1.5 s", slow: "Slow 2.5 s", manual: "Manual" };
const DEFAULT_PACE = "narrate";
// In these paces the chat bubble waits for the "Claude answers" step.
const HOLD_PACES = ["narrate", "slow", "manual"];

const Reveal = {
  PACE_MS, PACE_LABEL, DEFAULT_PACE, HOLD_PACES,

  // io: { now(), setTimer(fn, ms) -> handle, clearTimer(handle),
  //       show(step, index), hide(step, index), changed() }
  create(io) {
    return {
      mode: DEFAULT_PACE,
      holdAnswer: true,
      steps: [],              // every step of the current sequence, shown or not
      shown: 0,               // steps[0 .. shown-1] are on screen
      live: false,            // a live turn (events still arriving) or a replay
      lastShownAt: -Infinity,
      timer: null,
      waiters: [],            // { pred, fn } run when a matching step is revealed

      dwell() { return PACE_MS[this.mode]; },
      holds() { return HOLD_PACES.includes(this.mode) && this.holdAnswer; },
      counter() { return { shown: this.shown, total: this.steps.length, queued: this.steps.length - this.shown, live: this.live }; },
      last() { return this.shown ? this.steps[this.shown - 1] : null; },
      pending() { return this.shown < this.steps.length ? this.steps[this.steps.length - 1] : null; },
      isShown(step) { const i = this.steps.indexOf(step); return i >= 0 && i < this.shown; },

      setMode(mode) {
        this.mode = mode in PACE_MS ? mode : DEFAULT_PACE;
        this.cancelTimer();
        this.pump();
        this.releaseIfNotHolding();
        io.changed();
      },
      setHoldAnswer(on) {
        this.holdAnswer = !!on;
        this.releaseIfNotHolding();
      },

      // A new sequence. The caller flushes or resets the old one first.
      begin(live) {
        this.cancelTimer();
        this.steps = []; this.shown = 0; this.live = !!live; this.lastShownAt = -Infinity;
        io.changed();
      },
      add(step) {
        this.steps.push(step);
        this.pump();
        io.changed();
      },

      // Reveal every step that is due, then wait one dwell for the next.
      pump() {
        const dwell = this.dwell();
        if (dwell === null || this.timer || this.shown >= this.steps.length) return;
        // A step with weight 2 stays twice the dwell before the next one shows.
        const wait = this.lastShownAt + dwell * (this.lastWeight || 1) - io.now();
        if (wait <= 0) { this.revealOne(); this.pump(); return; }
        this.timer = io.setTimer(() => { this.timer = null; this.pump(); }, wait);
      },
      revealOne() {
        const i = this.shown;
        const step = this.steps[i];
        this.shown += 1;
        this.lastShownAt = io.now();
        this.lastWeight = step.weight || 1;
        io.show(step, i);
        for (const w of this.waiters.splice(0)) { if (w.pred(step)) w.fn(step); else this.waiters.push(w); }
        io.changed();
      },
      cancelTimer() { if (this.timer) { io.clearTimer(this.timer); this.timer = null; } },

      // ---- keys -------------------------------------------------------------
      next() { if (this.shown >= this.steps.length) return false; this.revealOne(); return true; },
      prev() {
        if (this.shown === 0) return false;
        this.shown -= 1;
        io.hide(this.steps[this.shown], this.shown);
        io.changed();
        return true;
      },
      end() {                       // everything queued, now; also "flush on send"
        this.cancelTimer();
        while (this.shown < this.steps.length) this.revealOne();
      },
      home() {                      // back to step 1, then carry on at the pace
        this.cancelTimer();
        while (this.shown > 0) this.prev();
        this.lastShownAt = -Infinity;
        if (this.steps.length) { this.revealOne(); this.pump(); }
      },
      // Right/Space/PageDown and Left/PageUp move only in Manual; End and
      // Home work in every pace, so a long narration can always be skipped.
      key(action) {
        if (action === "end") { this.end(); return true; }
        if (action === "home") { this.home(); return true; }
        if (this.mode !== "manual") return false;
        if (action === "next") return this.next();
        if (action === "prev") return this.prev();
        return false;
      },

      // ---- the held answer --------------------------------------------------
      // fn runs when a step matching pred is revealed, at once if it already
      // is. reset() drops waiters: a Reset also clears the chat.
      onRevealed(pred, fn) {
        for (let i = 0; i < this.shown; i++) if (pred(this.steps[i])) { fn(this.steps[i]); return; }
        this.waiters.push({ pred, fn });
      },
      releaseIfNotHolding() {
        if (this.holds()) return;
        for (const w of this.waiters.splice(0)) w.fn(null);
      },

      reset() {                     // Reset button: the pace is kept
        this.cancelTimer();
        this.steps = []; this.shown = 0; this.live = false; this.lastShownAt = -Infinity;
        this.waiters = [];
        io.changed();
      },
    };
  },

  // Which key does what. Keys typed into a field belong to the field.
  keyAction(key, tagName) {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(String(tagName || "").toUpperCase())) return null;
    const nav = { " ": "next", ArrowRight: "next", PageDown: "next", ArrowLeft: "prev", PageUp: "prev", End: "end", Home: "home" };
    if (key in nav) return { action: nav[key], prevent: true };
    if (key === "d" || key === "D") return { action: "toggle", prevent: true };
    // Presenter keys: A autopilot, K the closing card (Kwaheri), N notes.
    const presenter = { a: "autopilot", k: "closing", n: "notes" };
    const lower = String(key).toLowerCase();
    if (key.length === 1 && lower in presenter) return { action: presenter[lower], prevent: true };
    return null;
  },

  // The Manual hint, from counter() and the pace.
  hintText(counter, mode) {
    if (mode !== "manual") return "";
    const sofar = counter.live ? " so far" : "";
    if (counter.total === 0) return "Manual: waiting for the first step";
    if (counter.queued === 0) return `Step ${counter.shown} of ${counter.total}${sofar}, all shown. Left goes back, Home restarts`;
    return `Step ${counter.shown} of ${counter.total}${sofar}, press Right for the next step, End shows all`;
  },

  // Events already in the history when the page loaded are shown at once.
  isHistory(ev, instantUntil) { return ev.seq <= instantUntil; },
};

if (typeof module !== "undefined") module.exports = Reveal;
