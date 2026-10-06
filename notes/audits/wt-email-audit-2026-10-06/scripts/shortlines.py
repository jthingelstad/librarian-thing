import json,re,sys,collections
sys.path.insert(0,'/tmp/wtq/audit')
from audit import email_extract, archive_extract, norm, BOILER_PAT, EMAIL_ONLY
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
ext={k:email_extract(v['file']) for k,v in per.items()}
df=collections.Counter()
for x in ext.values(): df.update({norm(l) for l in x['lines']})
out={}
for k in sorted(per,key=lambda x:float(x.split('-')[0])):
    a=' '+norm(archive_extract(k)['text'])+' '
    miss=[]
    for l in ext[k]['lines']:
        n=norm(l); w=n.split()
        if not (2<=len(w)<=7) or df[n]>=3 or BOILER_PAT.search(l) or EMAIL_ONLY.search(l): continue
        if re.fullmatch(r'[\w.-]+\.[a-z]{2,}',l.strip()): continue
        if re.match(r'^(#?\d+ / )?\w{3} \d+, 20\d\d',l): continue
        if ' '+n+' ' not in a: miss.append(l)
    out[k]=miss
    if miss: print(k,len(miss),miss[:6])
json.dump(out,open('shortlines.json','w'),indent=1,ensure_ascii=False)
