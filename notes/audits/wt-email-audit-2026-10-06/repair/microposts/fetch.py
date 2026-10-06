"""Fetch each missing photo from the email's URL and from the rehost it will point at; same bytes?"""
import json, hashlib, urllib.request
from concurrent.futures import ThreadPoolExecutor
P = [r for r in json.load(open('plan.json')) if not r['kept']]

def get(u):
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'wt-archive-repair/1.0'})
        with urllib.request.urlopen(req, timeout=60) as f:
            b = f.read(); return dict(status=f.status, final=f.geturl(), type=f.headers.get('Content-Type'), size=len(b), sha=hashlib.sha256(b).hexdigest())
    except Exception as e:
        return dict(error=str(e)[:200])

def one(r):
    return dict(src=r['src'], target=r['target'], email=get(r['src']), rehost=get(r['target']))

with ThreadPoolExecutor(8) as ex: out = list(ex.map(one, P))
json.dump(out, open('fetch.json', 'w'), indent=1)
same = sum(1 for o in out if o['email'].get('sha') and o['email'].get('sha') == o['rehost'].get('sha'))
print('photos', len(out), 'same bytes', same)
for o in out:
    if not (o['email'].get('sha') and o['email'].get('sha') == o['rehost'].get('sha')): print(o)
