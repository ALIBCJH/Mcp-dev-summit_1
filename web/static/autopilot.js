// Autopilot: runs the whole demo hands-free. The startup replay, then each
// quick prompt in turn (waiting for the answer to be shown), then the
// closing card. Press A or the button to start; again to stop after the
// current step. A rehearsal tool, and a fallback on the day.
"use strict";

const AUTOPILOT = { afterStartupMs: 3000, afterAnswerMs: 5000, beforeClosingMs: 2000 };

const Autopilot = {
  running: false,
  stopAsked: false,
  onStatus: null,   // (text) => void

  async run(io) {
    // io: { replayStartup(): Promise, prompts: [text], send(text): Promise, closing(): void, pace() -> mode, setPace(mode) }
    if (this.running) { this.stopAsked = true; this.status("stopping after this step…"); return; }
    this.running = true; this.stopAsked = false;
    const total = io.prompts.length + 2;
    let n = 0;
    const step = (what) => { n += 1; this.status(`${n}/${total} ${what}`); };
    try {
      if (io.pace() === "manual") io.setPace("narrate");   // Manual would wait for keys forever
      step("startup");
      await io.replayStartup();
      await this.wait(AUTOPILOT.afterStartupMs);
      for (const text of io.prompts) {
        if (this.stopAsked) break;
        step(text.length > 28 ? text.slice(0, 27) + "…" : text);
        await io.send(text);
        await this.wait(AUTOPILOT.afterAnswerMs);
      }
      if (!this.stopAsked) {
        step("closing");
        await this.wait(AUTOPILOT.beforeClosingMs);
        io.closing();
      }
    } finally {
      this.running = false; this.stopAsked = false;
      this.status("");
    }
  },

  wait(ms) { return new Promise((r) => setTimeout(r, ms)); },
  status(text) { if (this.onStatus) this.onStatus(text); },
};

if (typeof module !== "undefined") module.exports = Autopilot;
