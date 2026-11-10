// Small DOM helpers shared by panel.js. No framework, no build step.
"use strict";

const CLIP_LIMIT = 600;       // characters shown before "show more"
const WIRE_PREVIEW = 160;     // characters of raw JSON in a wire row header

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

// A collapsible row: <details class="row FAMILY"><summary>label head</summary>body</details>
// body may be a node, a function returning a node (rendered on first expand), or null.
function row(family, label, head, body) {
  const d = el("details", "row " + family);
  const s = el("summary");
  s.appendChild(el("span", "label", label));
  const h = el("span", "head");
  if (typeof head === "string") h.textContent = head; else h.appendChild(head);
  s.appendChild(h);
  d.appendChild(s);
  if (body) {
    const holder = el("div", "body");
    d.appendChild(holder);
    if (typeof body === "function") {
      d.addEventListener("toggle", () => {
        if (d.open && !holder.hasChildNodes()) holder.appendChild(body());
      }, { once: false });
    } else {
      holder.appendChild(body);
    }
  } else {
    d.classList.add("leaf");
    s.style.listStyle = "none";
  }
  return d;
}

function pretty(value) {
  let text;
  if (typeof value === "string") {
    try { text = JSON.stringify(JSON.parse(value), null, 2); } catch (e) { text = value; }
  } else {
    text = JSON.stringify(value, null, 2);
  }
  return el("pre", "json", text);
}

// Long text: first CLIP_LIMIT characters, then a "show more" button that
// swaps in the full text. The full text is always in the page data, never lost.
function clip(text, cls) {
  const wrap = el("div");
  const pre = el("pre", cls || "text");
  if (text.length <= CLIP_LIMIT) {
    pre.textContent = text;
    wrap.appendChild(pre);
    return wrap;
  }
  pre.textContent = text.slice(0, CLIP_LIMIT) + " …";
  wrap.appendChild(pre);
  const btn = el("button", "showmore", `show more (${fmtInt(text.length)} characters)`);
  btn.addEventListener("click", () => {
    if (btn.dataset.full === "1") {
      pre.textContent = text.slice(0, CLIP_LIMIT) + " …"; btn.textContent = `show more (${fmtInt(text.length)} characters)`; btn.dataset.full = "0";
    } else {
      pre.textContent = text; btn.textContent = "show less"; btn.dataset.full = "1";
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

function labelled(title, node) {
  const wrap = el("div");
  wrap.appendChild(el("div", "sub", title));
  wrap.appendChild(node);
  return wrap;
}
