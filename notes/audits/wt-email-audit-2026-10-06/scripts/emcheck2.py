import json,re,email
from email import policy
from bs4 import BeautifulSoup
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
for k in ['24','27','29','36','38','40']:
    m=email.message_from_binary_file(open(per[k]['file'],'rb'),policy=policy.default)
    s=BeautifulSoup(m.get_body(preferencelist=('html',)).get_content(),'html.parser')
    ems=[' '.join(x.get_text(' ').split()) for x in s.find_all(['em','i'])]
    print(k,[x[:100] for x in ems if len(x.split())>=8 and not re.match(r'\w{3} \d+, 20\d\d at',x)][:6])
