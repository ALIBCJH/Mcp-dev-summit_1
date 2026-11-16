// Tiny markdown for the chat pane. Escape everything first, then add only
// whitelisted tags: p, br, strong, em, code, ul, li. No links: a URL stays
// plain text. No raw HTML survives.
"use strict";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineMarkdown(escaped) {
  // Code first, so its contents are not touched by bold or italics.
  const codes = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Italics need non-blank text right inside the asterisks, so "2 * 3 * 4" stays arithmetic.
  out = out.replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

function renderMarkdown(text) {
  const lines = escapeHtml(String(text || "").replace(/\r\n/g, "\n")).split("\n");
  const html = [];
  let para = [], list = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inlineMarkdown).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list.length) { html.push(`<ul>${list.map((l) => `<li>${inlineMarkdown(l)}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") { flushPara(); flushList(); continue; }
    const item = line.match(/^\s*[-*] (.*)$/);
    if (item) { flushPara(); list.push(item[1]); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return html.join("");
}

if (typeof module !== "undefined") module.exports = { renderMarkdown, escapeHtml, inlineMarkdown };
