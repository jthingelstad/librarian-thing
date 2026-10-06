"""Round 4 plan: every micropost photo the email has and the archive lost, and where it goes.

For each such image, the anchor is the nearest text block before it in the email (the post's
text, or its date header for a photo-only post). The anchor is found in the archive by words;
the photo goes after that line, among the post's other photos in the email's order.
"""
import os, json, difflib, sys
from urllib.parse import urlparse
from bs4 import Comment
from common import *

BLOCK = ['p', 'div', 'td', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'blockquote']
FENCE = ('🎁', 'Promotion', 'Give Back', 'Now Reading')
IMG = re.compile(r'^!\[[^\]]*\]\(([^)\s]+)\)\s*$')

def base(u): return os.path.basename(urlparse(u).path).lower()

def is_micro(src):
    h = urlparse(src).netloc
    return h in ('micro.thingelstad.com', 'www.thingelstad.com', 'cdn.uploads.micro.blog', 'thingelstad.micro.blog') and '/uploads/' in src or 'cdn.uploads.micro.blog' in h

def target(src):
    m = re.search(r'/uploads/(\d{4})/([^/?#]+)$', urlparse(src).path)
    return f'https://cdn.uploads.micro.blog/890/{m.group(1)}/{m.group(2)}' if m else None

def prev_block(img):
    for st in img.find_all_previous(string=True):
        if isinstance(st, Comment) or not st.strip(): continue
        blk = st.find_parent(BLOCK) or st
        return blk.get_text(' ', strip=True) if blk is not st else st.strip(), blk
    return '', None

def occurrence(s, blk, text):
    """Which copy of this text the block is, in document order (WT105 has a post twice)."""
    seen = []
    for b in s.find_all(BLOCK):
        if b.get_text(' ', strip=True) == text and not any(x in b.parents for x in seen) and not any(b in x.parents for x in seen):
            seen.append(b)
    for k, b in enumerate(seen):
        if b is blk or blk in b.parents or b in getattr(blk, 'parents', []): return k
    return 0

def plain(line):
    line = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', line)
    line = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', line)
    return re.sub(r'^(#{1,6}|>|[-*+]|\d+\.)\s+', '', line)

def sections(lines):
    sec, out = '', []
    for l in lines:
        if l.startswith('## '): sec = l
        out.append(sec)
    return out

def plan_issue(n):
    s = soup_of(n); fm, body = read(n); lines = body.split('\n'); secs = sections(lines)
    have = {base(u) for u in re.findall(r'!\[[^\]]*\]\(([^)\s]+)\)', body)}
    LW = [W(plain(l)) for l in lines]
    rows = []
    for img in s.find_all('img'):
        src = img.get('src', '')
        if not is_micro(src): continue
        r = dict(n=n, src=src, alt=(img.get('alt') or '').strip(), kept=base(src) in have, target=target(src))
        anc, blk = prev_block(img); r['anchor'] = anc; aw = W(anc)
        if aw:
            scores = sorted(((difflib.SequenceMatcher(None, aw, LW[i], autojunk=False).ratio(), i) for i in range(len(lines)) if LW[i]), key=lambda x: (-x[0], x[1]))
        else:  # emoji-only post (WT125 "⚾️💥🤩"): the line itself
            scores = [(1.0, i) for i in range(len(lines)) if lines[i].strip() == anc.strip()]
        exact = [i for sc, i in scores if sc == 1.0]
        if len(exact) > 1:  # the same text twice: the email's copy k is the archive's copy k
            k = occurrence(s, blk, anc); r['copy'] = k
            scores = [(1.0, exact[k])] + [(0.0, i) for i in exact if i != exact[k]]
        best, i = scores[0] if scores else (0, None)
        second = scores[1][0] if len(scores) > 1 else 0
        r.update(score=round(best, 3), second=round(second, 3), line=i, line_text=lines[i][:160] if i is not None else '', section=secs[i] if i is not None else '')
        r['fenced'] = any(f in r['section'] for f in FENCE)
        rows.append(r)
    return rows

if __name__ == '__main__':
    ns = [int(a) for a in sys.argv[1:]] or range(23, 131)
    allr = []
    for n in ns:
        if email_path(n): allr += plan_issue(n)
    json.dump(allr, open('plan.json', 'w'), indent=1, ensure_ascii=False)
    miss = [r for r in allr if not r['kept']]
    print('micro imgs', len(allr), 'kept', len(allr) - len(miss), 'missing', len(miss))
    weak = [r for r in miss if r['score'] < 0.9 or r['second'] > r['score'] - 0.15 and r['second'] > 0.6]
    print('weak anchors', len(weak), 'fenced', sum(r['fenced'] for r in miss), 'no target', sum(not r['target'] for r in miss))
    import collections
    print(collections.Counter(r['section'] for r in miss).most_common(12))
    for r in weak[:40]: print(r['n'], r['score'], r['second'], repr(r['anchor'][:70]), '|', r['line_text'][:70])
