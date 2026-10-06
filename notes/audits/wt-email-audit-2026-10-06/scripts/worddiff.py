"""Word-level diff of each email paragraph against its best-matching archive line.
Finds words the archive dropped inside otherwise-present paragraphs."""
import json,re,sys,collections,difflib
sys.path.insert(0,'/tmp/wtq/audit')
from audit import email_extract, archive_extract, norm, trigrams, md_to_text, BOILER_PAT, EMAIL_ONLY
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
out={}
DOMAIN=re.compile(r'^(www )?[a-z0-9-]+( [a-z0-9-]+)*$')
for k in sorted(per,key=lambda x:float(x.split('-')[0])):
    x=email_extract(per[k]['file']); a=archive_extract(k)
    alines=[norm(md_to_text(l)).split() for l in a['md'].split('\n')]
    alines=[l for l in alines if len(l)>=3]
    atri=[trigrams(l) for l in alines]
    drops=[]
    seen=set()
    for l in x['lines']:
        if BOILER_PAT.search(l) or EMAIL_ONLY.search(l): continue
        ew=norm(l).split()
        if len(ew)<6 or tuple(ew) in seen: continue
        seen.add(tuple(ew))
        et=trigrams(ew)
        best=max(range(len(atri)),key=lambda i:len(et&atri[i])) if atri else None
        if best is None: continue
        ov=len(et&atri[best])/max(1,len(et))
        if ov<0.5: continue
        sm=difflib.SequenceMatcher(a=ew,b=alines[best],autojunk=False)
        for tag,i1,i2,j1,j2 in sm.get_opcodes():
            if tag in('delete','replace') and i2>i1:
                dropped=ew[i1:i2]; added=alines[best][j1:j2]
                # ignore if dropped words appear right after in archive (reordering) or are trailing domain labels
                if i2==len(ew) and re.search(r'\.[a-z]{2,}$',l.strip()) and len(dropped)<=4: continue
                if tag=='replace' and len(dropped)==len(added)==1: continue  # one-word spelling/typo fix
                if all(len(w)<=1 for w in dropped): continue
                ctx=' '.join(ew[max(0,i1-6):i2+4])
                drops.append({'dropped':' '.join(dropped),'added':' '.join(added),'ctx':ctx})
    out[k]=drops
json.dump(out,open('worddiff.json','w'),indent=1,ensure_ascii=False)
for k,v in out.items():
    print(k,len(v))
