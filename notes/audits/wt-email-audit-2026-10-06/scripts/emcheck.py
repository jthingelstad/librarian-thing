import json,re,email
from email import policy
from bs4 import BeautifulSoup
import sys
sys.path.insert(0,'/tmp/wtq/audit')
from audit import norm, archive_extract, md_to_text
inv=json.load(open('inventory.json'))
per={}
for e in inv['emails']:
    if e['issue'] and (e['issue'] not in per or per[e['issue']]['dup']): per[e['issue']]=e
for k in [str(i) for i in range(23,42)]:
    m=email.message_from_binary_file(open(per[k]['file'],'rb'),policy=policy.default)
    s=BeautifulSoup(m.get_body(preferencelist=('html',)).get_content(),'html.parser')
    ems=[' '.join(x.get_text(' ').split()) for x in s.find_all(['em','i'])]
    ems=[x for x in ems if len(x.split())>=8]
    md=archive_extract(k)['md']
    # are they italic in archive?
    ital=0; plain=0; quoted=0
    for x in ems:
        probe=norm(x)[:50]
        for line in md.split('\n'):
            if probe and probe in norm(md_to_text(line)):
                if line.lstrip().startswith('>'): quoted+=1
                elif re.search(r'(^|\s)[*_]\S', line): ital+=1
                else: plain+=1
                break
    print(k,'long em in email',len(ems),'archive: quoted',quoted,'italic',ital,'plain',plain, '|', (ems[0][:90] if ems else ''))
