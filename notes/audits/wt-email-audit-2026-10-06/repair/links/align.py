"""Align every WT23-130 archive line with its email block, word by word, links included.

Each side becomes tokens (surface, norm, url|None). An archive line is matched to the
email segment (inline run between block boundaries) with the most similar words.
"""
import difflib, html as htmlmod, json, re, sys, unicodedata
from bs4 import NavigableString, Comment
sys.path.insert(0, '/tmp/wtq/r3')
from common import A, read, soup_of

INLINE = {'a', 'strong', 'b', 'em', 'i', 'span', 'small', 'u', 'code', 'sup', 'sub', 'font', 'mark', 'abbr', 's', 'strike', 'del', 'ins', 'img'}
MD_LINK = re.compile(r'(?<!!)\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]*)[^)]*\)')
WORD = re.compile(r'\S+')

def nurl(u):
    from urllib.parse import unquote
    u = unquote(htmlmod.unescape(u or '').strip()).strip('"\'“”‘’ ')  # an href pasted with its quotes
    u = re.sub(r'^https?://', '', u, flags=re.I)
    u = re.sub(r'^www\.', '', u, flags=re.I)
    u = re.sub(r'^micro\.thingelstad\.com/', 'thingelstad.com/', u, flags=re.I)
    if 'list-manage.com/track' in u: return 'TRACKED'
    u = re.sub(r'^(mailchi\.mp/[^?#]*)\?e=[0-9a-f]+$', r'\1', u, flags=re.I)  # a recipient's subscriber ID (stripped 10-06)
    return u.rstrip('/').lower()

def toks(text, url, emph=False):
    out = []
    for w in WORD.findall(text):
        nw = A.norm(w)
        if nw:
            for part in nw.split():
                out.append((w, part, url, emph))
    return out

def email_segments(n):
    s = soup_of(n)
    for c in s.find_all(string=lambda x: isinstance(x, Comment)): c.extract()
    segs, cur = [], []
    def flush():
        if cur: segs.append(list(cur)); cur.clear()
    def walk(node, url, emph):
        for ch in node.children:
            if isinstance(ch, NavigableString):
                cur.extend(toks(str(ch), url, emph))
            elif ch.name:
                if ch.name not in INLINE: flush()
                u = ch.get('href') if ch.name == 'a' else url
                walk(ch, nurl(u) if ch.name == 'a' else url, emph or ch.name in ('strong', 'b', 'em', 'i'))
                if ch.name not in INLINE: flush()
    walk(s, None, False); flush()
    return [g for g in segs if g]

def md_line_tokens(line):
    t = re.sub(r'^(\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s+|>\s?)+', '', line)
    out, pos = [], 0
    for m in MD_LINK.finditer(t):
        out += toks(re.sub(r'[*_`]', ' ', t[pos:m.start()]), None)
        out += toks(re.sub(r'[*_`]', ' ', m.group(1)), nurl(m.group(2)))
        pos = m.end()
    out += toks(re.sub(r'[*_`]', ' ', t[pos:]), None)
    # bare URLs in text are links in the email sense
    return out

def link_spans(ts):
    spans, i = [], 0
    while i < len(ts):
        if ts[i][2]:
            j = i
            while j < len(ts) and ts[j][2] == ts[i][2]: j += 1
            spans.append((i, j, ts[i][2])); i = j
        else: i += 1
    return spans

def match(n):
    _, body = read(n)
    segs = email_segments(n)
    index = {}
    for k, g in enumerate(segs):
        ws = [t[1] for t in g]
        for i in range(len(ws) - 1): index.setdefault((ws[i], ws[i + 1]), set()).add(k)
    pairs = []
    for ln, line in enumerate(body.split('\n')):
        if not line.strip() or line.lstrip().startswith(('![', '<img', '---')): continue
        at = md_line_tokens(line)
        if len(at) < 3: continue
        aw = [t[1] for t in at]
        cands = {}
        for i in range(len(aw) - 1):
            for k in index.get((aw[i], aw[i + 1]), ()): cands[k] = cands.get(k, 0) + 1
        best, br = None, 0
        for k, _ in sorted(cands.items(), key=lambda x: -x[1])[:8]:
            ew = [t[1] for t in segs[k]]
            # the archive line may be part of a longer email segment: score on the line's own length
            sm = difflib.SequenceMatcher(None, aw, ew, autojunk=False)
            blocks = sum(b.size for b in sm.get_matching_blocks())
            r = blocks / len(aw)
            if r > br: best, br = k, r
        pairs.append({'ln': ln, 'line': line, 'seg': best, 'score': round(br, 3)})
    return segs, pairs

if __name__ == '__main__':
    n = int(sys.argv[1])
    segs, pairs = match(n)
    for p in pairs:
        if p['seg'] is None: print(p['ln'], 'UNMATCHED', p['line'][:100]); continue
        print(p['ln'], p['score'], p['line'][:90], '||', ' '.join(t[0] for t in segs[p['seg']])[:90])
