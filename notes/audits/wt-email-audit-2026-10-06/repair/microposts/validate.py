"""Independent check of round 4 (micropost photos), against the emails and the base commit.

Separate from plan.py/apply.py: placement is checked by the last words of text before each
image (email vs archive), not by the planner's block matching.
  V0 front matter unchanged; old lines a subsequence of new; inserted lines blank or images
  V1 every inserted image is ![](https://cdn.uploads.micro.blog/890/YYYY/<file>), empty alt
  V2 added files = email upload photos missing at base, each once; nothing the base had
  V3 the text just before each added image is the text just before it in the email
  V4 the archive's upload photos are in the email's order
  V5 an added image renders as its own <p><img></p>, never inside a paragraph of text
  V6 no added image in a fenced (🎁 / Promotion / Give Back / Now Reading) or Photo section
"""
import os, re, sys, json, subprocess, difflib
from urllib.parse import urlparse
sys.path.insert(0, '/tmp/wtq/r4')
from common import soup_of, email_path, W
from bs4 import Comment

LT = os.environ.get('WTQ_LT', '/Users/otto/Projects/thingelstad.com/librarian-thing')
BASE = os.environ.get('WTQ_BASE', 'HEAD')
ADD = re.compile(r'^!\[\]\((https://cdn\.uploads\.micro\.blog/890/(\d{4})/([0-9a-f]+\.(?:jpg|jpeg|png|gif)))\)$')
ANYIMG = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')
fails = []

def F(n, msg): fails.append(f'WT{n}: {msg}')
def bn(u): return os.path.basename(urlparse(u).path).lower()
def split(t):
    i = t.index('\n---', 3) + 4
    return t[:i], t[i:]
def words_md(line):
    line = ANYIMG.sub(' ', line); line = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', line)
    return W(re.sub(r'^(#{1,6}|>|[-*+]|\d+\.)\s+', '', line))

def email_flow(n):
    """Document-order list of ('t', text) and ('i', src) from the email."""
    s = soup_of(n); flow = []
    for el in s.descendants:
        if getattr(el, 'name', None) == 'img' and el.get('src'): flow.append(('i', el['src']))
        elif isinstance(el, str) and not isinstance(el, Comment) and el.strip() and el.parent.name not in ('style', 'script'):
            flow.append(('t', el.strip()))
    return flow

def is_upload(src): return '/uploads/' in urlparse(src).path or 'cdn.uploads.micro.blog' in src

def tail_words(items, k=8):
    w = []
    for t in reversed(items):
        w = W(t) + w
        if len(w) >= k: break
    return w[-k:]

def render(md):
    p = subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'render_md.cjs')], input=md, capture_output=True, text=True, check=True)
    return p.stdout

def check(n):
    old = subprocess.run(['git', '-C', LT, 'show', f'{BASE}:data/issues/{n}/archive.md'], capture_output=True, text=True).stdout
    new = open(f'{LT}/data/issues/{n}/archive.md', encoding='utf-8').read()
    if old == new: return 0
    ofm, ob = split(old); nfm, nb = split(new)
    if ofm != nfm: F(n, 'front matter changed')
    ol, nl = ob.split('\n'), nb.split('\n')
    sm = difflib.SequenceMatcher(None, ol, nl, autojunk=False)
    added = []
    for op, a1, a2, b1, b2 in sm.get_opcodes():
        if op == 'equal': continue
        if op != 'insert': F(n, f'{op} at old line {a1}: {ol[a1:a2][:2]}'); continue
        for j in range(b1, b2):
            if not nl[j].strip(): continue
            if not ADD.match(nl[j]): F(n, f'inserted line is not a bare upload image: {nl[j][:80]}'); continue
            added.append(j)
    flow = email_flow(n)
    eimgs = [s for k, s in flow if k == 'i' and is_upload(s)]
    had = {bn(u) for u in ANYIMG.findall(ob)}
    want = [bn(s) for s in eimgs if bn(s) not in had]
    got = [bn(ADD.match(nl[j]).group(1)) for j in added]
    if sorted(got) != sorted(want): F(n, f'added {len(got)} != email-missing {len(want)}: extra {sorted(set(got)-set(want))[:3]} lacking {sorted(set(want)-set(got))[:3]}')
    if len(got) != len(set(got)): F(n, 'an image added twice')
    # V1 year path matches the email's
    eyear = {bn(s): m.group(1) for s in eimgs if (m := re.search(r'/(\d{4})/[^/]+$', urlparse(s).path))}
    for j in added:
        m = ADD.match(nl[j])
        if eyear.get(m.group(3).lower()) != m.group(2): F(n, f'year path {m.group(2)} != email {eyear.get(m.group(3).lower())} for {m.group(3)}')
    # V3 text before the image
    pos = {}
    for idx, (k, s) in enumerate(flow):
        if k == 'i': pos.setdefault(bn(s), idx)
    for j in added:
        b = bn(ADD.match(nl[j]).group(1))
        k = j - 1
        while k >= 0 and (not nl[k].strip() or ANYIMG.fullmatch(nl[k].strip())): k -= 1
        before_a = nl[k]
        texts = [s for kk, s in flow[:pos[b]] if kk == 't']
        ew, aw = tail_words(texts), words_md(before_a)[-8:]
        if not aw:
            # emoji-only post: compare the raw text
            if texts[-1].strip() != before_a.strip(): F(n, f'{b}: before-text {before_a!r} vs email {texts[-1]!r}')
        elif aw != ew[-len(aw):] if len(aw) < len(ew) else aw[-len(ew):] != ew:
            F(n, f'{b}: archive text before {aw} != email {ew}')
    # V4 order: each added image sits between neighbours the email puts before and after it
    rank = {b: i for i, b in reversed(list(enumerate(bn(s) for s in eimgs)))}
    seq = [(j, bn(ADD.match(nl[j]).group(1)) if j in added else bn(m)) for j, l in enumerate(nl) for m in ANYIMG.findall(l) if bn(m) in rank]
    for k, (j, b) in enumerate(seq):
        if j not in added: continue
        if k > 0 and rank[seq[k-1][1]] > rank[b]: F(n, f'{b} comes after {seq[k-1][1]}, which the email puts later')
        if k + 1 < len(seq) and rank[seq[k+1][1]] < rank[b]: F(n, f'{b} comes before {seq[k+1][1]}, which the email puts earlier')
    # V5 render: each added image is its own paragraph
    html = render(nb)
    for j in added:
        u = ADD.match(nl[j]).group(1)
        m = re.search(r'<p>((?:(?!</p>).)*?<img src="' + re.escape(u) + r'"(?:(?!</p>).)*)</p>', html, re.S)
        if not m: F(n, f'{bn(u)} is not inside a paragraph of the render')
        elif re.sub(r'<img src="[^"]*" alt="">|<br\s*/?>|\s', '', m.group(1)): F(n, f'{bn(u)} shares a paragraph with text')
    # V6 sections
    sec = ''
    for i, l in enumerate(nl):
        if l.startswith('## '): sec = l
        if i in added and (any(f in sec for f in ('🎁', 'Promotion', 'Give Back', 'Now Reading')) or re.search(r'photo', sec, re.I)):
            F(n, f'image added under {sec}')
    return len(added)

if __name__ == '__main__':
    ns = [int(a) for a in sys.argv[1:]] or range(23, 131)
    total = sum(check(n) for n in ns if email_path(n))
    print('added images checked', total)
    print('\n'.join(fails) if fails else 'PASS')
    sys.exit(1 if fails else 0)
