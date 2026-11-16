// The opening: "Welcome to Safiri", then both halves of the page boot at
// once, each behind its own 3-second ring timer (3, 2, 1). The shell (the
// chat) then shows; the kernel (the panel) launches the startup replay.
//
// One clock (see timeline.js) drives both rings, so a pause (Space or
// click) freezes both; Enter or Esc skips.
"use strict";

const CURTAIN = { welcomeMs: 3300, bootMs: 3000 };
const RING_LENGTH = 327;   // circumference of the ring circle (r = 52) in the SVG

const Curtain = {
  CURTAIN,
  totalMs() { return CURTAIN.welcomeMs + CURTAIN.bootMs; },
  phaseAt(ms) { return ms < CURTAIN.welcomeMs ? "welcome" : "boot"; },
  // ?intro=0 skips the opening (handy while developing).
  wanted(search) { return new URLSearchParams(search || "").get("intro") !== "0"; },

  // The number on the rings at `ms` into the boot, and how far through that second.
  bootBeat(ms) {
    if (ms < 0 || ms >= CURTAIN.bootMs) return null;
    const second = Math.floor(ms / 1000);
    return { label: String(Math.ceil(CURTAIN.bootMs / 1000) - second), fraction: (ms - second * 1000) / 1000 };
  },

  run(onDone) {
    const box = document.getElementById("curtain");
    const counts = [...box.querySelectorAll(".count")];
    const rings = [...box.querySelectorAll(".ring .arc")];
    let shown = "";
    // Fresh start, so a second run inherits nothing.
    box.classList.remove("boot");
    for (const c of counts) c.textContent = "";
    for (const r of rings) r.style.strokeDashoffset = RING_LENGTH;

    const paint = (elapsed) => {
      if (Curtain.phaseAt(elapsed) === "welcome") return;
      box.classList.add("boot");
      const beat = Curtain.bootBeat(elapsed - CURTAIN.welcomeMs);
      if (!beat) return;
      if (beat.label !== shown) {
        shown = beat.label;
        for (const c of counts) { c.textContent = beat.label; c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); }
      }
      for (const r of rings) r.style.strokeDashoffset = RING_LENGTH * (1 - beat.fraction);
    };
    Timeline.run({ box, totalMs: Curtain.totalMs(), paint, onDone: () => { box.classList.remove("boot"); onDone(); } });
  },
};

if (typeof module !== "undefined") module.exports = Curtain;
