import json,email,collections,re
from email import policy
from bs4 import BeautifulSoup
from urllib.parse import urlparse
inv=json.load(open('/tmp/wtq/audit/inventory.json'))
c=collections.Counter(); ex={}
for e in inv['emails']:
    m=email.message_from_binary_file(open(e['file'],'rb'),policy=policy.default)
    s=BeautifulSoup(m.get_body(preferencelist=('html',)).get_content(),'html.parser')
    for i in s.find_all('img'):
        src=i.get('src','')
        u=urlparse(src); key=u.netloc+'/'+'/'.join(u.path.split('/')[1:2])
        c[key]+=1; ex.setdefault(key,(src[:120],i.get('width'),i.get('alt')))
for k,v in c.most_common(60): print(v,k,ex[k])
