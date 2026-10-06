import json,re,email,sys
from email import policy
from bs4 import BeautifulSoup
sys.path.insert(0,'/tmp/wtq/audit')
from audit import norm, archive_body
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
DATE=re.compile(r'^\w{3} \d+, 20\d\d at')
out={}
for k in sorted(per,key=lambda x:float(x.split('-')[0])):
    m=email.message_from_binary_file(open(per[k]['file'],'rb'),policy=policy.default)
    s=BeautifulSoup(m.get_body(preferencelist=('html',)).get_content(),'html.parser')
    md=archive_body(k)
    # emphasized spans in md (normalized)
    mdem=[norm(x) for x in re.findall(r'\*\*(.+?)\*\*|__(.+?)__',md) for x in x if x]
    mdem+=[norm(x) for x in re.findall(r'(?<![*\w])[*_]([^*_\n]+?)[*_](?![*\w])',md)]
    mdem+= [norm(x) for x in re.findall(r'<(?:strong|b|em|i)>(.*?)</(?:strong|b|em|i)>',md)]
    mdem_join=' | '.join(mdem)
    tot=lost=0; ex=[]
    for t in s.find_all(['strong','b','em','i']):
        if t.find_parent(['a','h1','h2','h3','h4']) or t.find('a'): continue
        txt=' '.join(t.get_text(' ').split())
        n=norm(txt)
        if len(n.split())<2 or DATE.match(txt): continue
        par=t.find_parent(['p','li','blockquote','td'])
        if par is not None and norm(par.get_text(' '))==n: continue  # whole paragraph emphasized (template/caption)
        if t.find_parent('blockquote') is None and float(k.split('-')[0])<=37 and t.name in('em','i') and len(n.split())>=8: continue  # italic quote passages counted elsewhere
        tot+=1
        if n not in mdem_join and n not in norm(md).replace(' ',' ') : continue  # text gone entirely; counted elsewhere
        if n not in mdem_join:
            lost+=1; ex.append(txt[:80])
    out[k]={'emph':tot,'lost':lost,'ex':ex[:4]}
    if lost: print(k,tot,lost,ex[:3])
json.dump(out,open('emph.json','w'),indent=1,ensure_ascii=False)
