"""Round 4: put back the micropost photos the archive lost, from plan.json and fetch.json.

Each photo goes on its own line in the image run after its anchor line (the post's text),
in the email's order, as ![](https://cdn.uploads.micro.blog/890/YYYY/<file>) - the WT53-130
convention, and the file fetch.py found byte-identical to the email's. Images already in
the run keep their lines and their order; a run holding anything else is left alone.
"""
import json, os, re, sys, collections
from common import read, ISS
from plan import base, IMG

P = json.load(open('plan.json'))
same = {o['src'] for o in json.load(open('fetch.json')) if o['email'].get('sha') and o['email']['sha'] == o['rehost'].get('sha')}
ONLY = {int(a) for a in sys.argv[1:] if a.isdigit()}
WRITE = '--write' in sys.argv
report = collections.Counter(); skipped = []

by_issue = collections.defaultdict(list)
for r in P: by_issue[r['n']].append(r)

for n, rows in sorted(by_issue.items()):
    if ONLY and n not in ONLY: continue
    miss = [r for r in rows if not r['kept']]
    if not miss: continue
    fm, body = read(n); lines = body.split('\n')
    anchors = sorted({r['line'] for r in miss}, reverse=True)  # bottom-up keeps line numbers valid
    for L in anchors:
        group = [r for r in rows if r['line'] == L]           # email order, kept and missing
        if any(r['fenced'] for r in group) or any(not r['kept'] and r['src'] not in same for r in group):
            skipped.append((n, L, 'fenced or unverified')); continue
        j = L + 1; run = []
        while j < len(lines) and (not lines[j].strip() or IMG.match(lines[j])):
            if lines[j].strip(): run.append(lines[j])
            j += 1
        have = [base(IMG.match(x).group(1)) for x in run]
        order = [base(r['src']) for r in group]
        if any(h not in order for h in have) or [h for h in order if h in have] != have:
            skipped.append((n, L, f'run holds other images {have}')); continue
        new = []
        for r in group:
            b = base(r['src'])
            if b in have: new.append(run[have.index(b)])
            elif not r['kept']: new.append(f"![]({r['target']})"); report['added'] += 1
        tail = [''] if j < len(lines) else []
        lines[L + 1:j] = [''] + new + tail
        report['anchors'] += 1
    report['issues'] += 1
    if WRITE:
        open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(fm + '\n'.join(lines))
print(dict(report)); print('skipped', skipped)
