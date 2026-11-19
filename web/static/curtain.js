// The opening: "Welcome to Safiri", then both halves of the page boot at
// once, each behind its own ring timer (3, 2, 1, two seconds per number),
// then the Linux screen: where the names shell and kernel come from. A
// terminal types on the shell side and a kernel log streams on the kernel
// side, both looping, until the presenter presses Next. The shell (the
// chat) then shows; the kernel (the panel) launches the startup replay.
//
// One clock (see timeline.js) drives both rings, so a pause (Space or
// click) freezes both; Enter or Esc skips.
"use strict";

// beatMs is one number on the rings; bootMs is the whole count. Slow enough
// for a room to read the two cards, not so slow that the audience waits.
const CURTAIN = { welcomeMs: 5500, beatMs: 2000, bootMs: 6000 };
const RING_LENGTH = 327;   // circumference of the ring circle (r = 52) in the SVG

// The Linux screen. Everything typed on it lives here, so the words can
// change without touching the logic below. Times in ms: charMs per typed
// character, outMs pause after an output line, lineMs per kernel log line,
// restMs quiet at the end of a loop before it starts again.
const LINUX = {
  prompt: "traveller@safiri:~$ ",
  shell: [
    { kind: "cmd", text: "whoami" },
    { kind: "out", text: "traveller" },
    { kind: "cmd", text: 'safiri "Fly me to Diani for 2 nights"' },
    { kind: "out", text: "handing this to the kernel…" },
  ],
  kernel: [
    { tag: "boot", text: "[    0.000000] Safiri kernel booting" },
    { tag: "sched", text: "[    0.120000] sched:   agent loop ready, 8 calls per turn" },
    { tag: "perm", text: "[    0.240000] perm:    policy loaded, 5 tools allowed, default deny" },
    { tag: "driver", text: "[    0.360000] driver:  flights    stdio   loaded" },
    { tag: "driver", text: "[    0.480000] driver:  hotels     stdio   loaded" },
    { tag: "driver", text: "[    0.600000] driver:  bookings   http    loaded" },
    { tag: "syscall", text: "[    1.000000] syscall: search_flights(NBO -> UKA)         ok" },
    { tag: "syscall", text: '[    1.200000] syscall: search_hotels("Diani Beach", 2)    ok' },
    { tag: "perm", text: "[    1.400000] perm:    book_trip allowed, side effect" },
    { tag: "syscall", text: "[    1.600000] syscall: book_trip(KF101, DIA-GALU, 2)      ok" },
  ],
  charMs: 75, outMs: 900, lineMs: 550, restMs: 3500,
};

const Curtain = {
  CURTAIN,
  LINUX,
  // The timed part. The Linux screen after it has no length: it holds for Next.
  totalMs() { return CURTAIN.welcomeMs + CURTAIN.bootMs; },
  phaseAt(ms) {
    if (ms < CURTAIN.welcomeMs) return "welcome";
    return ms < Curtain.totalMs() ? "boot" : "linux";
  },
  // ?intro=0 skips the opening (handy while developing).
  wanted(search) { return new URLSearchParams(search || "").get("intro") !== "0"; },

  // The number on the rings at `ms` into the boot, and how far through that beat.
  bootBeat(ms) {
    if (ms < 0 || ms >= CURTAIN.bootMs) return null;
    const beat = Math.floor(ms / CURTAIN.beatMs);
    const counts = Math.ceil(CURTAIN.bootMs / CURTAIN.beatMs);
    return { label: String(counts - beat), fraction: (ms - beat * CURTAIN.beatMs) / CURTAIN.beatMs };
  },

  // The shell terminal at `ms` into the Linux screen: the lines on screen,
  // the command being typed cut to the characters typed so far, and where
  // the cursor sits. Loops: after the last line and a rest, it starts over.
  shellFrame(ms) {
    const starts = [];
    let t = 0;
    for (const line of LINUX.shell) {
      starts.push(t);
      t += line.kind === "cmd" ? line.text.length * LINUX.charMs + LINUX.outMs : LINUX.outMs;
    }
    const m = ms % (t + LINUX.restMs);
    const lines = [];
    LINUX.shell.forEach((line, i) => {
      if (m < starts[i]) return;
      if (line.kind === "out") { lines.push({ kind: "out", text: line.text, cursor: false }); return; }
      const typed = Math.min(line.text.length, Math.floor((m - starts[i]) / LINUX.charMs));
      lines.push({ kind: "cmd", text: line.text.slice(0, typed), cursor: typed < line.text.length });
    });
    // Resting after the script: an empty prompt with the cursor, like a real shell.
    if (m >= t) lines.push({ kind: "cmd", text: "", cursor: true });
    return lines;
  },

  // The kernel log at `ms` into the Linux screen: one more line every lineMs, then a rest, then again.
  kernelFrame(ms) {
    const m = ms % (LINUX.kernel.length * LINUX.lineMs + LINUX.restMs);
    return LINUX.kernel.slice(0, Math.min(LINUX.kernel.length, Math.floor(m / LINUX.lineMs) + 1));
  },

  run(onDone) {
    const box = document.getElementById("curtain");
    const counts = [...box.querySelectorAll(".count")];
    const rings = [...box.querySelectorAll(".ring .arc")];
    const shellTerm = box.querySelector(".linux-screen .shell .term");
    const kernelTerm = box.querySelector(".linux-screen .kernel .term");
    let shown = "";
    // Fresh start, so a second run inherits nothing.
    box.classList.remove("boot", "linux");
    for (const c of counts) c.textContent = "";
    for (const r of rings) r.style.strokeDashoffset = RING_LENGTH;
    shellTerm.replaceChildren(); kernelTerm.replaceChildren();

    const paint = (elapsed) => {
      const phase = Curtain.phaseAt(elapsed);
      if (phase === "welcome") return;
      if (phase === "linux") {
        box.classList.add("linux");
        syncShell(shellTerm, Curtain.shellFrame(elapsed - Curtain.totalMs()));
        syncKernel(kernelTerm, Curtain.kernelFrame(elapsed - Curtain.totalMs()));
        return;
      }
      box.classList.add("boot");
      const beat = Curtain.bootBeat(elapsed - CURTAIN.welcomeMs);
      if (!beat) return;
      if (beat.label !== shown) {
        shown = beat.label;
        for (const c of counts) { c.textContent = beat.label; c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); }
      }
      for (const r of rings) r.style.strokeDashoffset = RING_LENGTH * (1 - beat.fraction);
    };
    Timeline.run({ box, totalMs: Curtain.totalMs(), paint, hold: true, onDone: () => { box.classList.remove("boot", "linux"); onDone(); } });
  },
};

// DOM sync for the two terminals. Lines already on screen are kept (so their
// entrance animation plays once); only the typed command changes in place.
function syncShell(term, lines) {
  if (lines.length < term.children.length) term.replaceChildren();   // the loop started over
  for (let i = term.children.length; i < lines.length; i += 1) {
    const div = document.createElement("div");
    div.className = `tl ${lines[i].kind}`;
    if (lines[i].kind === "cmd") {
      const prompt = document.createElement("span"); prompt.className = "prompt"; prompt.textContent = LINUX.prompt;
      const txt = document.createElement("span"); txt.className = "txt";
      div.append(prompt, txt);
    }
    term.append(div);
  }
  lines.forEach((line, i) => {
    const div = term.children[i];
    if (line.kind === "cmd") div.querySelector(".txt").textContent = line.text;
    else div.textContent = line.text;
    div.classList.toggle("cursor", line.cursor);
  });
}

function syncKernel(term, lines) {
  if (lines.length < term.children.length) term.replaceChildren();
  for (let i = term.children.length; i < lines.length; i += 1) {
    const div = document.createElement("div");
    div.className = `tl k-${lines[i].tag}`;
    div.textContent = lines[i].text;
    term.append(div);
  }
}

if (typeof module !== "undefined") module.exports = Curtain;
