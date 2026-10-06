"""Every upload photo sits under the post header the email has it under (WT23-130)."""
import re, os, collections
from urllib.parse import urlparse
from bs4 import Comment
from common import soup_of, email_path, read
LBL = re.compile(r'\w+day @ \d{1,2}:\d{2} [AP]M')
HEAD = re.compile(r'^(?:### )?\[(\w+day @ \d{1,2}:\d{2} [AP]M)\]\(')
bad, checked, skipped = [], 0, collections.Counter()
for n in range(23, 131):
    if not email_path(n): continue
    s = soup_of(n); fm, body = read(n)
    eh = {}
    for img in s.find_all('img'):
        src = img.get('src', '')
        if '/uploads/' not in urlparse(src).path: continue
        lab = next((st.strip() for st in img.find_all_previous(string=True) if not isinstance(st, Comment) and LBL.fullmatch(st.strip())), None)
        eh.setdefault(os.path.basename(src).lower(), lab)
    cur = None
    for l in body.split('\n'):
        m = HEAD.match(l)
        if m: cur = m.group(1); continue
        if l.startswith('## '): cur = None
        for u in re.findall(r'!\[[^\]]*\]\(([^)\s]+)\)', l):
            b = os.path.basename(urlparse(u).path).lower()
            if b not in eh: continue
            if eh[b] is None or cur is None: skipped[n] += 1; continue
            checked += 1
            if eh[b].lower() != cur.lower(): bad.append((n, b, 'archive', cur, 'email', eh[b]))
print('checked', checked, 'skipped (no labels)', dict(skipped)); print('wrong post', bad or 'none')
