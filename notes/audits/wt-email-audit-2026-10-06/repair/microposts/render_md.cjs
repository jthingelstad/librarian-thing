// stdin markdown -> HTML with the weekly site's markdown-it settings.
const md = require('/Users/otto/Projects/thingelstad.com/weekly.thingelstad.com/node_modules/markdown-it')({ html: true, linkify: true, typographer: true });
let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(md.render(s)));
