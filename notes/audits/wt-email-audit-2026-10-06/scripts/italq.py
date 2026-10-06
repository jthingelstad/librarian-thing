import json,re,email,sys
from email import policy
from bs4 import BeautifulSoup
sys.path.insert(0,'/tmp/wtq/audit')
from audit import norm, archive_body, md_to_text
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
DATE=re.compile(r'^\w{3,9} \d+, 20\d\d,? at|^\w{3} \d+, 20\d\d')
out={}
for k in [str(i) for i in range(23,131)]:
    m=email.message_from_binary_file(open(per[k]['file'],'rb'),policy=policy.default)
    s=BeautifulSoup(m.get_body(preferencelist=('html',)).get_content(),'html.parser')
    md=archive_body(k).split('\n')
    plain=[];kept=0
    for t in s.find_all(['em','i']):
        if t.find_parent('blockquote') or t.find_parent('a'): continue
        x=' '.join(t.get_text(' ').split())
        if len(x.split())<8 or DATE.match(x): continue
        probe=norm(x)[:50]
        for line in md:
            if probe in norm(md_to_text(line)):
                if line.lstrip().startswith('>') or re.search(r'(^|\s)[*_]\S',line): kept+=1
                else: plain.append(x[:160])
                break
    out[k]={'italic_quotes_plain':plain,'kept':kept}
json.dump(out,open('italq.json','w'),indent=1,ensure_ascii=False)
print({k:len(v['italic_quotes_plain']) for k,v in out.items() if v['italic_quotes_plain']})
