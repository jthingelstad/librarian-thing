"""Round 1: email quotes -> archive blockquotes, WT23-130. Writes the archive
in place (librarian-thing/data/issues) and a plan to plan.json. Only adds
'> ' markers and paragraph breaks; validate.py proves that independently."""
import unicodedata, html as htmlmod
from common import *

OPEN = set('“"‘\'([*_')

def stream(body):
    """Normalised word stream of body with a map back to body offsets.
    Markdown link targets and brackets are masked out."""
    mask = [False] * len(body)
    for m in re.finditer(r'\]\([^)\s]*\)', body):
        for i in range(m.start(), m.end()): mask[i] = True
    for m in re.finditer(r'\[', body): mask[m.start()] = True
    for m in re.finditer(r'^[ \t]*(\d+\.|[-*+])[ \t]', body, re.M):
        for i in range(m.start(), m.end()): mask[i] = True
    out, idx = [], []
    for i, ch in enumerate(body):
        if mask[i]: c = ' '
        else:
            c = unicodedata.normalize('NFKC', ch)
            if c in '­​‌‍️⁠': continue
            c = A.QUOTES.get(c, c).lower()
            c = re.sub(r'[^\w\s]', ' ', c).replace('_', ' ')
        for cc in c:
            if cc.isspace():
                if out and out[-1] == ' ': continue
                cc = ' '
            out.append(cc); idx.append(i)
    return ''.join(out), idx

def quotes_for(n):
    """The email's quotes in document order: every top-level <blockquote>
    and, through WT37 (the italics era), italic passages of 6+ words that
    are not a whole paragraph (blurbs, App Store copy), a photo date line
    or the footer. The 3-7 word italics of WT23-37 were read by eye: only
    WT23's "Currently Apple ships more microprocessors than Intel." is a
    quote; the rest are emphasis, dates and the footer."""
    s = soup_of(n)
    _, body = read(n)
    lines = body.split('\n'); qs = []
    for e in s.find_all(['blockquote', 'em', 'i']):
        q = ' '.join(e.get_text(' ').split())
        if e.name == 'blockquote':
            if not e.find_parent('blockquote'): qs.append(q)
            continue
        if n >= 38 or e.find_parent('blockquote') or len(W(q)) < 6 or q.startswith('Copyright'): continue
        qj = ' '.join(W(q)); sec = ''; hit = None
        for l in lines:
            if l.startswith('#'): sec = l
            lw = ' '.join(W(A.md_to_text(l)))
            if qj[:60] in lw: hit = (sec, lw); break
        if hit is None or hit[0].startswith('## The end'): continue
        if hit[1] == qj: continue        # whole paragraph: a blurb or App Store copy (WT1-22 rule)
        qs.append(q)
    return qs

def squash(t):
    return re.sub(r'\s', '', t).translate(str.maketrans('\u201c\u201d\u2018\u2019', '""\'\'')).replace('...', '\u2026')

def find_spans(n, body, qs):
    st, idx = stream(body)
    spans, notes, pos = [], [], 0
    for q in qs:
        qj = ' '.join(W(q))
        if len(qj.split()) < 3: notes.append(('tiny', q)); continue
        pat = re.compile(r'(?<!\w)' + re.escape(qj) + r'(?!\w)')
        m = pat.search(st, pos) or pat.search(st)
        if not m: notes.append(('notfound', q[:120])); continue
        if len(pat.findall(st)) > 1: notes.append(('ambiguous', q[:120]))
        s, e = idx[m.start()], idx[m.end() - 1] + 1
        while s > 0 and body[s - 1] in OPEN: s -= 1
        while e < len(body) and not body[e].isspace(): e += 1
        # A leading '...' or a closing '.', ').' or emoji the conversion left
        # on its own beside the quote belongs to it.
        # Only what the email's own quote starts or ends with.
        head = squash(re.match(r'\W*', q).group())
        tail = squash(re.search(r'\W*$', q).group())
        ls = body.rfind('\n', 0, s) + 1
        lead = squash(body[ls:s])
        if lead and head.endswith(lead) and not re.search(r'\w', body[ls:s]): s = ls
        le = body.find('\n', e); le = len(body) if le < 0 else le
        rest = squash(body[e:le])
        if rest and tail.endswith(rest) and not re.search(r'\w', body[e:le]): e = le
        spans.append((s, e, q)); pos = m.end()
    return spans, notes

ATTRIB = re.compile(r'^#{1,6} (?=\[?\u2014)', re.M)   # a tweet's "-- Name (@handle) date" line made a heading

def quote_block(text):
    lines = []
    for l in text.strip('\n').split('\n'):
        if ATTRIB.match(l):
            lines.append('')       # the attribution is its own line, as in the email
            l = ATTRIB.sub('', l)
        lines.append(l)
    return '\n'.join('>' if not l.strip() else '> ' + l for l in lines)

def apply(body, spans):
    spans = sorted(set((s, e) for s, e, _ in spans))
    merged = []
    for s, e in spans:
        if merged and s <= merged[-1][1]: merged[-1] = (merged[-1][0], max(e, merged[-1][1]))
        else: merged.append((s, e))
    for s, e in reversed(merged):
        ls = body.rfind('\n', 0, s) + 1
        le = body.find('\n', e); le = len(body) if le < 0 else le
        before, after = body[ls:s].rstrip(), body[e:le].strip()
        block = quote_block(body[s:e])
        new = (before + '\n\n' if before else '') + block + ('\n\n' + after if after else '')
        rest = body[le:]
        if not after and rest.startswith('\n') and rest[1:2] not in ('', '\n'):
            new += '\n'          # the next line would join the quote (lazy continuation)
        if not before and ls > 0 and body[ls - 2:ls] != '\n\n':
            new = '\n' + new
        body = body[:ls] + new + rest
    return body

if __name__ == '__main__':
    only = [int(a) for a in sys.argv[1:] if a.isdigit()]
    write = '--write' in sys.argv
    plan = {}
    for n in only or range(23, 131):
        front, body = read(n)
        qs = quotes_for(n)
        spans, notes = find_spans(n, body, qs)
        heads = [q for s, e, q in spans if re.search(r'^#', ATTRIB.sub('', body[s:e]), re.M)]
        if heads: notes += [('heading-inside', h[:80]) for h in heads]
        new = apply(body, spans)
        plan[n] = {'quotes': len(qs), 'applied': len(spans), 'notes': notes}
        if write and new != body:
            open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(front + new)
    json.dump(plan, open('plan.json', 'w'), indent=1, ensure_ascii=False)
    tot = sum(p['quotes'] for p in plan.values()); app = sum(p['applied'] for p in plan.values())
    print(f'{len(plan)} issues, {tot} quotes, {app} placed')
    for n, p in plan.items():
        for k, q in p['notes']: print(n, k, q)
