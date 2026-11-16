// A presenter-paced timeline, shared by curtain.js and intro.js.
//
// Time is counted in a tick, not with CSS transitions, so pausing freezes
// everything exactly where it is. Space or a click pauses and resumes;
// Enter or Esc skips. While it runs, keys belong to it and reach nothing
// else (not the reveal controller).
"use strict";

const TICK_MS = 40;

const Timeline = {
  // opts: { box, totalMs, paint(elapsedMs), onDone }
  run(opts) {
    const { box, totalMs, paint, onDone } = opts;
    let elapsed = 0, last = performance.now(), paused = false, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(tick);
      document.removeEventListener("keydown", onKey, true);
      box.removeEventListener("click", togglePause);
      box.classList.add("leaving");
      setTimeout(() => { box.hidden = true; box.classList.remove("leaving", "paused"); onDone(); }, 400);
    };
    const togglePause = () => {
      paused = !paused;
      box.classList.toggle("paused", paused);   // CSS animations pause on this class
    };
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === " ") togglePause();
      else if (e.key === "Enter" || e.key === "Escape") finish();
    };
    document.addEventListener("keydown", onKey, true);
    box.addEventListener("click", togglePause);

    box.hidden = false;
    box.classList.remove("paused", "leaving");
    const tick = setInterval(() => {
      const now = performance.now();
      if (!paused) elapsed += now - last;
      last = now;
      paint(elapsed);
      if (elapsed >= totalMs) finish();
    }, TICK_MS);
    return { finish };
  },
};

if (typeof module !== "undefined") module.exports = Timeline;
