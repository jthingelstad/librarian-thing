"""Check the link repair line by line, independently of rebuild.py.

L0 front matter: unchanged apart from word_count; nothing in a "## Promotion" or "## Now Reading" section changes.
Every changed line, old (HEAD) vs new (working tree), rendered with the site's markdown-it:
L1 shape: same line count; same markdown prefix (list, heading, quote marker).
L2 nothing invented: every new word is in the old line or in the email.
L3 nothing lost: no email word the old line carried is missing from the new one; and a word the old line had and the new one lacks was link text the email titles
   differently, a duplicated title, the WT23-31 "->" marker, or a plain-text URL now linked.
L4 URLs: every URL in the old line is still linked; a new URL is one the email links to; no Mailchimp
   subscriber ID (?e=) anywhere.
L5 anchors: every link the repair made or changed has text that is an anchor text in the email (or a same-length near match,
   for kept corrections such as van/von).
L6 form: bold, italics and 💬 are exactly the old line's (content is restored, not format).
L8 form: no change that only alters case, quote marks or commas.
L7 render: no stray "](http", "**" or "_word_" left as literal text.
"""
import collections, difflib, json, re, subprocess, sys, urllib.parse
sys.path.insert(0, '/tmp/wtq/r3')
from common import A, soup_of
import os
LT = os.environ.get('WTQ_LT', '/Users/otto/Projects/thingelstad.com/librarian-thing')
PREFIX = re.compile(r'^(\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s+|>\s?)*')
fails = collections.defaultdict(list)
def norm_words(s): return A.norm(s).split()

def render(lines):
    return json.loads(subprocess.run(['node', '/tmp/wtq/r3/inline.cjs'], input=json.dumps(lines), capture_output=True, text=True, check=True).stdout)

def body_of(text): return text[text.index('---', 3) + 3:]

nums = [int(a) for a in sys.argv[1:] if a.isdigit()] or list(range(23, 131))
stats = collections.Counter()
for n in nums:
    old_t = subprocess.run(['git', '-C', LT, 'show', f'HEAD:data/issues/{n}/archive.md'], capture_output=True, text=True).stdout
    new_t = open(f'{LT}/data/issues/{n}/archive.md', encoding='utf-8').read()
    fm = lambda t: re.sub(r'(?m)^word_count: \d+$', '', t[:t.index('---', 3)])
    if fm(old_t) != fm(new_t): fails[n].append('L0 front matter changed beyond word_count')
    old, new = body_of(old_t).split('\n'), body_of(new_t).split('\n')
    if len(old) != len(new): fails[n].append('L1 line count changed'); continue
    idx = [i for i in range(len(old)) if old[i] != new[i]]
    sec = None
    for i, l in enumerate(old):
        if l.startswith('## '): sec = l
        if sec and ('Promotion' in sec or 'Now Reading' in sec) and i in idx: fails[n].append(f'L0 line {i} is in a {sec!r} section, which must stay as it is')
    if not idx: continue
    s = soup_of(n)
    E = norm_words(s.get_text(' ')); e_words = set(E)
    e_anchor = [' '.join(norm_words(a.get_text(' '))) for a in s.find_all('a')]
    e_anchor_set = set(e_anchor)
    e_href = {re.sub(r'^https?://(www\.)?', '', a.get('href', '')).rstrip('/').lower() for a in s.find_all('a')}
    e_emph = {' '.join(norm_words(t.get_text(' '))) for t in s.find_all(['strong', 'b', 'em', 'i'])}
    ro, rn = render([old[i] for i in idx]), render([new[i] for i in idx])
    for k, i in enumerate(idx):
        stats['lines'] += 1
        o, w = ro[k], rn[k]; tag = f'line {i}'
        if PREFIX.match(old[i]).group(0) != PREFIX.match(new[i]).group(0): fails[n].append(f'L1 {tag} prefix changed')
        ow, nw = norm_words(o['text']), norm_words(w['text'])
        invented = [x for x in nw if x not in ow and x not in e_words]
        if invented: fails[n].append(f'L2 {tag} invented {invented[:5]}')
        lost = collections.Counter(ow) - collections.Counter(nw)
        o_linkw = collections.Counter(x for t, _ in o['links'] for x in norm_words(t))
        plain = set(x for u in re.findall(r'\((https?://[^)\s]+)\)', old[i]) for x in norm_words(u))
        unexplained = [x for x in lost.elements() if not (o_linkw[x] or x in plain or ow.count(x) > 1)]
        if unexplained: fails[n].append(f'L3 {tag} lost {unexplained[:6]}')
        # L3b: line up the new line with its passage in the email; an email word the new
        # line lacks must have been missing from the old line too (the repair removed none)
        sm = difflib.SequenceMatcher(None, E, nw, autojunk=False)
        big = max(sm.get_matching_blocks(), key=lambda b: b.size)
        if big.size >= 3:
            lo = max(0, big.a - big.b - 8); win = E[lo:lo + len(nw) + 16]
            ops = difflib.SequenceMatcher(None, win, nw, autojunk=False).get_opcodes()
            while ops and ops[0][0] == 'delete': ops = ops[1:]
            while ops and ops[-1][0] == 'delete': ops = ops[:-1]
            oc, nc = collections.Counter(ow), collections.Counter(nw)
            gone = [x for op, i1, i2, _, _ in ops if op in ('delete', 'replace') for x in win[i1:i2] if oc[x] > nc[x]]
            if gone: fails[n].append(f'L3 {tag} dropped email words {gone[:6]}')
        uq = urllib.parse.unquote
        o_urls = {uq(u) for _, u in o['links']} | {uq(u) for u in re.findall(r'\((https?://[^)\s]+)\)', old[i])}
        n_urls = {uq(u) for _, u in w['links']}
        if o_urls - n_urls: fails[n].append(f'L4 {tag} URL dropped {sorted(o_urls - n_urls)[:2]}')
        for u in n_urls:
            if re.search(r'mailchi\.mp/.*[?&]e=', u): fails[n].append(f'L4 {tag} Mailchimp subscriber ID in {u}')
        for u in n_urls - o_urls:
            if re.sub(r'^https?://(www\.)?', '', u).rstrip('/').lower() not in e_href: fails[n].append(f'L4 {tag} new URL not in the email {u}')
            else: stats['urls added'] += 1
        o_pairs = {(t, uq(u)) for t, u in o['links']}
        for t, u in w['links']:
            if (t, uq(u)) in o_pairs: continue  # a link the repair left as it was
            a = ' '.join(norm_words(t))
            if a not in e_anchor_set and not any(len(a.split()) == len(x.split()) and difflib.SequenceMatcher(None, a, x).ratio() >= 0.85 for x in e_anchor):
                fails[n].append(f'L5 {tag} anchor not in the email: {t[:60]!r}')
        for kind in ('strong', 'em'):
            if sorted(w[kind]) != sorted(o[kind]): fails[n].append(f'L6 {tag} {kind} changed: {o[kind]} -> {w[kind]}')
        if new[i].count('💬') > old[i].count('💬'): fails[n].append(f'L6 {tag} 💬 added')
        # L8: the email's case, quote marks and commas are form, not content: the old form stands
        # compared on the markdown with link markup removed: the renderer curls straight
        # quotes by context, so a moved link can change the rendered quote with no edit
        bare = lambda x: re.sub(r'\]\([^)\s]*\)|[\[\]]', '', x)
        ob, nb = bare(old[i]), bare(new[i])
        sm8 = difflib.SequenceMatcher(None, ob, nb, autojunk=False)
        for op, a1, a2, b1, b2 in sm8.get_opcodes():
            a, b = ob[a1:a2], nb[b1:b2]
            if op != 'equal' and ((op == 'replace' and a.lower() == b.lower() and a != b) or (a + b and set(a + b) <= set('"“”\'‘’,;:'))):
                fails[n].append(f'L8 {tag} form-only change {a!r} -> {b!r}')
        if w['leftovers'] and not o['leftovers']: fails[n].append(f'L7 {tag} markup left as text: {w["text"][:80]!r}')
print('checked', stats['lines'], 'changed lines in', len(nums), 'issues;', stats['urls added'], 'URLs added from the email')
for n in sorted(fails):
    for f in fails[n]: print('FAIL', n, f)
sys.exit(1 if fails else 0)
