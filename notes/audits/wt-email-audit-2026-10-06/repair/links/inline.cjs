// stdin: JSON list of markdown lines. stdout: per line {text, links:[[text,href]], strong:[], em:[], leftovers}
const md = require('/Users/otto/Projects/thingelstad.com/weekly.thingelstad.com/node_modules/markdown-it')({ html: true, linkify: true, typographer: true });
const lines = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = lines.map((line) => {
  const body = line.replace(/^(\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s+|>\s?)+/, '');
  const toks = md.parseInline(body, {})[0].children;
  const r = { text: '', links: [], strong: [], em: [] };
  const stack = [];
  for (const t of toks) {
    if (t.type === 'link_open') stack.push({ kind: 'link', href: t.attrGet('href'), text: '' });
    else if (t.type === 'strong_open') stack.push({ kind: 'strong', text: '' });
    else if (t.type === 'em_open') stack.push({ kind: 'em', text: '' });
    else if (/_close$/.test(t.type)) {
      const s = stack.pop();
      if (!s) continue;
      if (s.kind === 'link') r.links.push([s.text, s.href]); else r[s.kind].push(s.text);
    } else if (t.type === 'text' || t.type === 'code_inline' || t.type === 'softbreak') {
      const c = t.type === 'softbreak' ? ' ' : t.content;
      r.text += c; for (const s of stack) s.text += c;
    }
  }
  r.leftovers = /\]\(https?:|\*\*|(^|\s)_\S|\S_(\s|$)/.test(r.text);
  return r;
});
process.stdout.write(JSON.stringify(out));
