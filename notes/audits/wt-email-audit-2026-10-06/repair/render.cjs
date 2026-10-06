// Render archive bodies with the weekly site's markdown-it settings; print
// {N: {quotes: [top-level blockquote text], text: whole visible text}}.
const fs = require('fs');
const md = require('/Users/otto/Projects/thingelstad.com/weekly.thingelstad.com/node_modules/markdown-it')({ html: true, linkify: true, typographer: true });
const { JSDOM } = (() => { try { return require('/Users/otto/Projects/thingelstad.com/weekly.thingelstad.com/node_modules/jsdom'); } catch { return {}; } })();
const out = {};
for (const file of process.argv.slice(2)) {
  const n = file.match(/(\d+)\/archive\.md$|(\d+)\.md$/).slice(1).find(Boolean);
  const src = fs.readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('---', 3) + 3);
  const tokens = md.parse(body, {});
  const quotes = []; let depth = 0, cur = null;
  for (const t of tokens) {
    if (t.type === 'blockquote_open') { if (depth++ === 0) cur = []; continue; }
    if (t.type === 'blockquote_close') { if (--depth === 0) { quotes.push(cur.join(' ')); cur = null; } continue; }
    if (cur && t.type === 'inline') cur.push(t.children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join(' '));
  }
  const headingsInQuotes = [];
  depth = 0;
  for (const t of tokens) {
    if (t.type === 'blockquote_open') depth++;
    if (t.type === 'blockquote_close') depth--;
    if (depth && t.type === 'heading_open') headingsInQuotes.push(t.map?.[0]);
  }
  out[n] = { quotes, headingsInQuotes };
}
process.stdout.write(JSON.stringify(out));
