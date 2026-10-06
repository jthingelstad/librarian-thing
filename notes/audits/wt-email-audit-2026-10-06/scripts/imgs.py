import json,re,email,os,collections,sys
from email import policy
from urllib.parse import urlparse
sys.path.insert(0,'/tmp/wtq/audit')
from audit import email_extract, archive_extract, img_kind
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
out={}
tot=collections.Counter()
for k in sorted(per,key=lambda x:float(x.split('-')[0])):
    if not (1<=float(k.split('-')[0])<=135): continue
    x=email_extract(per[k]['file']); a=archive_extract(k)
    ab={os.path.basename(urlparse(u).path).lower() for u in a['imgs']}
    ahosts=collections.Counter(urlparse(u).netloc for u in a['imgs'])
    g=collections.Counter()
    for i in x['imgs']:
        src=i['src']; host=urlparse(src).netloc; b=os.path.basename(urlparse(src).path).lower()
        kind=img_kind(src)
        if kind!='photo': g[kind]+=1; continue
        if 'gallery.mailchimp' in host or 'tinyletterapp' in host or 'buttondown' in host: g['hero/weekly']+=1; continue
        g['micro']+=1
        if b in ab: g['micro_kept']+=1
    # archive: hero images under files.thingelstad.com/weekly-thing/N/
    hero_a=sum(1 for u in a['imgs'] if '/weekly-thing/' in u)
    micro_a=sum(1 for u in a['imgs'] if '/weekly-thing/' not in u)
    out[k]=dict(g=dict(g),hero_a=hero_a,micro_a=micro_a,bare=len([l for l in a['md'].split('\n') if re.fullmatch(r'\s*https?://\S+\s*',l)]))
    print(k,dict(g),'archive hero',hero_a,'archive other',micro_a,'bare',out[k]['bare'])
json.dump(out,open('imgs.json','w'),indent=1)
