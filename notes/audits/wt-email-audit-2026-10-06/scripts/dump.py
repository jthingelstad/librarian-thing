import sys,email,re
from email import policy
from bs4 import BeautifulSoup
f=sys.argv[1]
m=email.message_from_binary_file(open(f,'rb'),policy=policy.default)
h=m.get_body(preferencelist=('html',)).get_content()
s=BeautifulSoup(h,'html.parser')
for t in s(['style','script','head']): t.decompose()
for el in s.find_all(['h1','h2','h3','h4','p','li','blockquote','img','td']):
    if el.name=='img':
        print('IMG',el.get('src','')[:90],'|',el.get('alt',''),el.get('width'))
    elif el.name=='td':
        continue
    else:
        t=' '.join(el.get_text(' ').split())
        if t: print(el.name.upper(),t[:160])
