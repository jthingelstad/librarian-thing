"""Round 1 validator, independent of apply_quotes.py. For each issue:
 V1  the text is unchanged: strip blockquote markers (and the '### ' that
     made a tweet attribution a heading) from before and after -> equal;
 V2  every quote the email marks is one rendered blockquote, and every
     rendered blockquote is made only of email quotes (no Jamie words in a
     quote, no quote left as Jamie's words);
 V3  no heading renders inside a quote.
Rendering is the weekly site's own markdown-it settings (render.cjs)."""
import subprocess, collections
from common import *
REPO = '/Users/otto/Projects/thingelstad.com/librarian-thing'
ATTR = re.compile(r'^#{1,6} (?=\[?—)', re.M)

def flat(body):
    body = re.sub(r'^>[ ]?', '', body, flags=re.M)
    body = ATTR.sub('', body)
    return ' '.join(body.split())

def email_quotes(n, before_body):
    s = soup_of(n)
    paras = {' '.join(W(A.md_to_text(p))) for p in re.split(r'\n\s*\n', before_body)}
    out = []
    for e in s.find_all(['blockquote', 'em', 'i']):
        q = ' '.join(e.get_text(' ').split())
        if e.name == 'blockquote':
            if not e.find_parent('blockquote'): out.append(q)
            continue
        if n >= 38 or e.find_parent('blockquote') or len(W(q)) < 6: continue
        if q.startswith('Copyright') or re.match(r'^[A-Z][a-z]{2} \d{1,2}, \d{4} at ', q): continue
        if ' '.join(W(q)) in paras: continue      # a whole paragraph: blurb / App Store copy, left as is
        out.append(q)
    return out

EDGE = str.maketrans({'\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'"})

def edges(t):
    t = t.translate(EDGE).replace('...', '\u2026').strip().strip('"\'').strip()
    return (t[:1], t[-1:]) if t else ('', '')

def bare_paras(body):
    return sorted(p.strip() for p in re.split(r'\n\s*\n', body) if p.strip() and not re.search(r'\w', p))

ns = [int(a) for a in sys.argv[1:]] or list(range(23, 131))
files = [f'{REPO}/data/issues/{n}/archive.md' for n in ns]
rendered = json.loads(subprocess.check_output(['node', 'render.cjs', *files]))
fails = collections.defaultdict(list); stats = collections.Counter()
for n in ns:
    before = subprocess.check_output(['git', '-C', REPO, 'show', f'HEAD:data/issues/{n}/archive.md'], text=True)
    after = open(f'{REPO}/data/issues/{n}/archive.md', encoding='utf-8').read()
    bf, bb = before[:before.index('---', 3) + 3], before[before.index('---', 3) + 3:]
    af, ab = after[:after.index('---', 3) + 3], after[after.index('---', 3) + 3:]
    if re.search(r'^>', bb, re.M): fails[n].append('V1 before already had > lines')
    if flat(bb) != flat(ab):
        a, b = flat(bb), flat(ab); i = next(i for i in range(min(len(a), len(b)) + 1) if i == min(len(a), len(b)) or a[i] != b[i])
        fails[n].append(f'V1 text changed near: {a[max(0,i-60):i+60]!r} vs {b[max(0,i-60):i+60]!r}')
    eq = [' '.join(W(q)) for q in email_quotes(n, bb)]
    rq = [' '.join(W(q)) for q in rendered[str(n)]['quotes']]
    stats['email'] += len(eq); stats['rendered'] += len(rq)
    # each rendered quote must be a run of consecutive email quotes, in order
    k = 0
    for r in rq:
        start = k; acc = ''
        while k < len(eq) and len(acc) < len(r):
            acc = (acc + ' ' + eq[k]).strip(); k += 1
        if acc != r:
            fails[n].append(f'V2 rendered quote is not email quotes: {r[:100]!r} / email {eq[start][:100] if start < len(eq) else None!r}')
            k = start + 1 if start < len(eq) and eq[start] in r else start
    if k < len(eq): fails[n].append(f'V2 {len(eq) - k} email quotes not rendered as quotes, first {eq[k][:100]!r}')
    eraw = email_quotes(n, bb); rraw = rendered[str(n)]['quotes']
    if len(eraw) == len(rraw):
        for e_, r_ in zip(eraw, rraw):
            if edges(e_) != edges(r_): fails[n].append(f'V4 quote edges {edges(r_)} vs email {edges(e_)}: {r_[:70]!r}')
    # A paragraph with no words left beside a quote must not be the quote's
    # own opening or closing punctuation (WT91 '.', WT130 ').', WT42 '...');
    # one the email keeps outside the quote is Jamie's (WT36's clap).
    new_bare = collections.Counter(bare_paras(ab)) - collections.Counter(bare_paras(bb))
    def own(p):
        t = p.translate(EDGE).replace(' ', '')
        return any(re.sub(r'\s', '', re.search(r'\W*$', q).group()).translate(EDGE).endswith(t)
                   or re.sub(r'\s', '', re.match(r'\W*', q).group()).translate(EDGE).replace('...', '\u2026').startswith(t)
                   for q in eraw)
    for p_ in new_bare:
        if own(p_): fails[n].append(f'V5 the quote\'s own punctuation left outside it: {p_!r}')
    if rendered[str(n)]['headingsInQuotes']: fails[n].append(f"V3 heading inside a quote at lines {rendered[str(n)]['headingsInQuotes']}")
    if bf != af: stats['front-matter-changed'] += 1
print(dict(stats), f'{len(ns) - len(fails)}/{len(ns)} issues pass')
for n, f in fails.items():
    for x in f: print(n, x)
