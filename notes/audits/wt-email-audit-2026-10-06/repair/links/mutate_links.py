"""Plant one defect at a time in the repaired worktree; the validator must fail on each."""
import os, re, subprocess, sys
LT = os.environ['WTQ_LT']; PY = sys.executable
def run(): return subprocess.run([PY, '/tmp/wtq/r3/validate_links.py', *NUMS], capture_output=True, text=True)
changed = subprocess.run(['git', '-C', LT, 'diff', '-U0', '--', 'data/issues'], capture_output=True, text=True).stdout
# pick a repaired line with a link and some plain words around it
hit = None; cur = None
for l in changed.split('\n'):
    m = re.match(r'\+\+\+ b/data/issues/(\d+)/archive.md', l)
    if m: cur = m.group(1); continue
    if l.startswith('+') and not l.startswith('+++') and l.count('](http') == 1 and len(l) > 120 and not l.startswith('+-') and '**' not in l and '_' not in l:
        hit = (cur, l[1:]); break
n, line = hit; NUMS = [n]
path = f'{LT}/data/issues/{n}/archive.md'; orig = open(path, encoding='utf-8').read()
m = re.search(r'\[([^\]]+)\]\((http[^)]+)\)', line)
anchor, url = m.group(1), m.group(2)
after = line[m.end():].split()
muts = {
 'invent a word': line.replace(' ', ' zorblax ', 1),
 'drop a plain word': line[:m.end()] + ' ' + ' '.join(after[1:]) if len(after) > 1 else None,
 'change the URL': line.replace(url, url + 'x'),
 'stretch the anchor one word': line.replace(f'[{anchor}]({url}) {after[0]}', f'[{anchor} {after[0]}]({url})') if after else None,
 'bold a phrase': line.replace(f'[{anchor}]', f'[**{anchor}**]'),
 'break the link': line.replace(f']({url})', f'] ({url})'),
 'change the prefix': '- ' + line,
 'delete the line': None,
 'front matter edit': 'FM',
 'add a 💬 lead-in': '💬 ' + line,
 'swap a quote mark': line.replace("'", '’', 1) if "'" in line else (line.replace('’', "'", 1) if '’' in line else None),
 'drop a comma': line.replace(',', '', 1) if ',' in line else None,
 'quote around the anchor': line.replace(f'[{anchor}]', f'"[{anchor}]', 1),
 'change a capital': re.sub(r'(?<=\s)([a-z])(?=[a-z]{3,}\s)', lambda m: m.group(1).upper(), line.split('](')[-1], count=1) and line[:m.end()] + re.sub(r'(?<=\s)([a-z])(?=[a-z]{3,}\s)', lambda mm: mm.group(1).upper(), line[m.end():], count=1),
}
caught = 0
for name, new in muts.items():
    if name == 'delete the line': text = orig.replace(line + '\n', '', 1)
    elif name == 'front matter edit': text = orig.replace('\ntitle:', '\ntitle: X', 1) if '\ntitle:' in orig else orig.replace('---\n', '---\nzz: 1\n', 1)
    elif new is None: print('n/a', name); continue
    else: text = orig.replace(line, new, 1)
    assert text != orig, name
    open(path, 'w', encoding='utf-8').write(text)
    r = run(); ok = r.returncode != 0; caught += ok
    print('CAUGHT' if ok else 'MISSED', name, '|', ([l for l in r.stdout.split('\n') if l.startswith('FAIL')] or [''])[0][:110])
open(path, 'w', encoding='utf-8').write(orig)
print('issue', n, 'caught', caught, 'of', len(muts)); assert run().returncode == 0
