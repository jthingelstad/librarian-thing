import re,os,sys,collections
sys.path.insert(0,'/tmp/wtq/audit')
from audit import archive_body, md_to_text, norm
ISS='/Users/otto/Projects/thingelstad.com/librarian-thing/data/issues/'
hits=collections.defaultdict(list)
for d in os.listdir(ISS):
    if not os.path.exists(ISS+d+'/archive.md'): continue
    for line in archive_body(d).split('\n'):
        ws=norm(md_to_text(line)).split()
        if len(ws)<10: continue
        seen={}
        for i in range(len(ws)-4):
            g=tuple(ws[i:i+5])
            if g in seen and i-seen[g]>=5:
                hits[d].append(line[:260]); break
            seen.setdefault(g,i)
for d in sorted(hits,key=lambda x:float(x.split('-')[0])):
    for l in hits[d]: print(d,'|',l)
