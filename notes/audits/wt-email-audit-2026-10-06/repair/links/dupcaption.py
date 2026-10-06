"""Drop the second copy of the weekly photo caption (WT55, 74, 79, 102, 111).

The archive carries the caption twice: once on its own after the photo, and again as the
first line of the date/place block. Each email has it once. The standalone copy keeps the
email's emoji and link, so the date block's copy goes. Checks: the dropped line says the
same words as the caption, the caption occurs once in the email, and nothing else changes.
"""
import os, re, sys
sys.path.insert(0, '/tmp/wtq/r3')
from common import ISS, soup_of, A
ISSUES = [55, 74, 79, 102, 111]
strip = lambda s: re.sub(r'\]\([^)]*\)|\(https?://[^)]*\)|\[', '', s)
write = '--write' in sys.argv
for n in ISSUES:
    p = f'{ISS}{n}/archive.md'; t = open(p, encoding='utf-8').read()
    m = re.search(r'\n(!\[[^\n]*\]\(https://files\.thingelstad\.com/weekly-thing/\d+/cover\.jpg\))\n\n([^\n]+)\n\n([^\n]+)\n', t)
    cap, dup = m.group(2), m.group(3)
    assert A.norm(strip(cap)).split() == A.norm(strip(dup)).split(), (n, cap, dup)
    email = re.sub(r'\s+', ' ', soup_of(n).get_text(' '))
    key = ' '.join(A.norm(strip(dup)).split()[:6])
    assert A.norm(email).count(key) == 1, (n, key)
    new = t[:m.start(3)] + t[m.end(3) + 1:]
    ol, nl = t.split('\n'), new.split('\n'); k = t[:m.start(3)].count('\n')
    assert ol[k] == dup and ol[:k] + ol[k + 1:] == nl
    print(n, 'drop:', dup)
    if write: open(p, 'w', encoding='utf-8').write(new)
