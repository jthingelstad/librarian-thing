// Render archive bodies with the weekly site's markdown-it; for each, list the
// sections as {heading, imgs: [src], text: [inline text in order, with "\u0000IMG" where an image sits]}.
const fs = require('fs');
const md = require('/Users/otto/Projects/thingelstad.com/weekly.thingelstad.com/node_modules/markdown-it')({ html: true, linkify: true, typographer: true });
const out = {};
for (const file of process.argv.slice(2)) {
  const n = file.match(/(\d+)\/archive\.md$/)[1];
  const src = fs.readFileSync(file, 'utf8');
  const tokens = md.parse(src.slice(src.indexOf('---', 3) + 3), {});
  const secs = [{ heading: null, imgs: [], text: [], alone: [] }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open' && t.tag === 'h2') { secs.push({ heading: tokens[i + 1].content, imgs: [], text: [], alone: [] }); i += 2; continue; }
    if (t.type !== 'inline') continue;
    const s = secs[secs.length - 1];
    for (const c of t.children) {
      if (c.type === 'image') { s.imgs.push(c.attrGet('src')); s.text.push('IMG'); s.alone.push(t.children.filter((x) => !(x.type === 'text' && !x.content.trim()) && x.type !== 'softbreak').length === 1); }
      else if (c.type === 'text') s.text.push(c.content);
    }
    const raw = t.content.match(/<img[^>]*src="([^"]+)"/g) || [];
    for (const r of raw) { s.imgs.push(r.match(/src="([^"]+)"/)[1]); s.text.push('IMG'); }
  }
  out[n] = secs;
}
process.stdout.write(JSON.stringify(out));
