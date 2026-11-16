// Pure: a turn's events in, a scoreboard out. No DOM, so it runs in Node.
//
// The events carry Claude's elapsed seconds and tokens per call; tools have
// no timing of their own, so they are counted, not timed. Nothing here is
// estimated: every number is a sum over what the host reported.
"use strict";

const Score = {
  // A turn's events (TurnStarted up to FinalAnswer or TurnFailed).
  tally(events) {
    const t = { modelCalls: 0, modelSeconds: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, toolErrors: 0, denied: 0, wire: 0, simulated: 0, failed: false };
    for (const ev of events) {
      switch (ev.type) {
        case "ModelCalled":
          t.modelCalls += 1; t.modelSeconds += ev.elapsed_seconds || 0;
          t.tokensIn += ev.input_tokens || 0; t.tokensOut += ev.output_tokens || 0;
          break;
        case "ToolRequested": t.toolCalls += 1; break;
        case "ToolReturned": if (ev.is_error) t.toolErrors += 1; break;
        case "PolicyDecided": if (!ev.allowed) t.denied += 1; break;
        case "WireMessage": t.wire += 1; break;
        case "SimulatedReply": t.simulated += 1; break;
        case "TurnFailed": t.failed = true; break;
        default: break;
      }
    }
    return t;
  },

  // Sum of several tallies (the session so far).
  sum(tallies) {
    const total = Score.tally([]);
    total.turns = tallies.length;
    for (const t of tallies) for (const k of Object.keys(t)) if (typeof t[k] === "number") total[k] += t[k];
    total.failed = tallies.some((t) => t.failed);
    return total;
  },

  // One line, for the chat and the panel.
  text(t) {
    const calls = `${t.modelCalls} call${t.modelCalls === 1 ? "" : "s"}`;
    const parts = [
      `Claude ${t.modelSeconds.toFixed(1)} s over ${calls}`,
      `${Score.k(t.tokensIn)} in / ${Score.k(t.tokensOut)} out`,
      `${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}${t.toolErrors ? ` (${t.toolErrors} error${t.toolErrors === 1 ? "" : "s"})` : ""}`,
      `${t.wire} message${t.wire === 1 ? "" : "s"} on the wire`,
    ];
    if (t.denied) parts.push(`${t.denied} blocked by policy`);
    if (t.simulated) parts.push(`${t.simulated} fooled call${t.simulated === 1 ? "" : "s"}`);
    if (t.failed) parts.push("turn failed");
    return parts.join(" · ");
  },

  k(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); },
};

if (typeof module !== "undefined") module.exports = Score;
