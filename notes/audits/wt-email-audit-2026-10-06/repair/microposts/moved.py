"""WT114, WT115: move four photos to the posts the email has them under.

Same-permalink posts (one blog post today) came into the archive with all their
photos piled under one header. The email shows each photo under its own post: in
WT114 "Heading West!" and "Deer Selfie" each have one; in WT115 "Thank you to all
the organizations" and "Having dinner with the city of Northfield!" each have one.
Checks the email first, then moves the line; nothing else changes.
"""
import re
from bs4 import Comment
from common import read, ISS, soup_of

MOVES = {114: {'245af20c2e.jpg': 'Sunday @ 11:51 AM', '68000282dc.jpg': 'Sunday @ 10:35 AM'},
         115: {'88946b4e4c.jpg': 'Sunday @ 5:40 PM', '3a0560a399.jpg': 'Sunday @ 5:08 PM'}}
HEAD = re.compile(r'^### \[(\w+day @ \d{1,2}:\d{2} [AP]M)\]\(')

def email_header_before(s, name):
    img = s.find('img', src=re.compile(re.escape(name)))
    for st in img.find_all_previous(string=True):
        if not isinstance(st, Comment) and re.fullmatch(r'\w+day @ \d{1,2}:\d{2} [AP]M', st.strip()): return st.strip()

for n, moves in MOVES.items():
    s = soup_of(n)
    for name, label in moves.items():
        assert email_header_before(s, name) == label, (n, name, email_header_before(s, name))
    fm, body = read(n); lines = body.split('\n')
    for name, label in moves.items():
        i = next(k for k, l in enumerate(lines) if l.startswith('![](') and l.rstrip(')').endswith(name))
        line = lines.pop(i)
        if not lines[i - 1].strip() and (i >= len(lines) or not lines[i].strip()): lines.pop(i - 1)  # the run is gone: one blank left
        h = [k for k, l in enumerate(lines) if (m := HEAD.match(l)) and m.group(1) == label]
        assert len(h) == 1, (n, label, h)
        end = next(k for k in range(h[0] + 1, len(lines)) if HEAD.match(lines[k]) or lines[k].startswith('## '))
        assert not any(l.startswith('![') for l in lines[h[0]:end]), (n, label, 'post already has photos')
        last = max(k for k in range(h[0] + 1, end) if lines[k].strip())
        lines[last + 1:last + 1] = ['', line]
        print(f'WT{n}: {name} -> {label}')
    open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(fm + '\n'.join(lines))
