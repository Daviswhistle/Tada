// Presentation never evaluates model HTML, terminal escapes or source scripts.
import { open } from 'node:fs/promises';
import { citationUrl } from '../../providers/src/research.ts';

export function plainText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
}
const html = value => plainText(value).replace(/[&<>"']/gu, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
export function terminalAnswer(answer) {
  return answer.parts.map(part => {
    const refs = [...new Map(part.citations.map(c => [c.url, c])).values()];
    return `${plainText(part.text)}${refs.map(c => `\n[${plainText(c.title)}] ${plainText(citationUrl(c.url))}`).join('')}`;
  }).join('\n\n');
}
export function answerHtml(answer) {
  const parts = answer.parts.map(part => {
    const citations = [...new Map(part.citations.map(c => [c.url, c])).values()];
    // Citation links are adjacent to their text block. We preserve API offsets
    // in memory but do not guess Unicode offset units to rewrite the text.
    return `<section><div class="answer">${html(part.text)}</div><p class="citations">${citations.map(c => `<a href="${html(citationUrl(c.url))}" rel="noreferrer noopener" target="_blank">${html(c.title)}</a>`).join(' · ')}</p></section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>Tada — research answer</title>
<style>body{font-family:system-ui,sans-serif;max-width:850px;margin:3rem auto;padding:0 1.5rem;line-height:1.7}h1{font-size:1.4rem}.answer{white-space:pre-wrap;overflow-wrap:anywhere}.citations{font-size:.9rem}footer{border-top:1px solid;padding-top:1rem;margin-top:2rem;font-size:.85rem}</style></head><body>
<h1>Tada</h1>${parts}
<footer>Source links are provider-supplied citations, not an independent verification certificate.<br>Model: ${html(answer.returnedModel)} · Response: ${html(answer.responseId)}</footer>
</body></html>\n`;
}
export async function saveAnswer(answer, destination) {
  const document = answerHtml(answer);
  // Only the human CLI command selects a destination. A model cannot write a
  // path, overwrite an existing artifact, or invoke this function as a tool.
  const file = await open(destination, 'wx', 0o600);
  try { await file.writeFile(document, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  // This is an explicit user export, not the daemon's ART-01 publish protocol.
}
