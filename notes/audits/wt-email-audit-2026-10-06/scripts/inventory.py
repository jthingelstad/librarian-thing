import email, glob, re, json, datetime, os
from email import policy
ISS='/Users/otto/Projects/thingelstad.com/librarian-thing/data/issues/'
def fm(path):
    s=open(path).read()
    parts=s.split('\n---\n',1)
    head=parts[0]
    num=re.search(r'^number:\s*(\S+)',head,re.M)
    subj=re.search(r"^subject:\s*(.*)$",head,re.M)
    pd=re.search(r"^publish_date:\s*'?([0-9-]+)",head,re.M)
    return dict(number=num.group(1) if num else None, subject=subj.group(1).strip("'\"") if subj else '', date=pd.group(1) if pd else None)
issues={}
for d in os.listdir(ISS):
    p=ISS+d+'/archive.md'
    if os.path.exists(p): issues[d]=fm(p)
bydate={}
for k,v in issues.items(): bydate.setdefault(v['date'],[]).append(k)
emails=[]
for f in sorted(glob.glob('/tmp/wteml/wt-export-eml/*.eml')):
    m=email.message_from_binary_file(open(f,'rb'),policy=policy.default)
    subj=str(m['subject'] or '')
    date=m['date']
    try: dt=email.utils.parsedate_to_datetime(date)
    except Exception: dt=None
    base=os.path.basename(f)
    issue=None; how=None
    mm=re.search(r'(?:Weekly Thing #?|WT)(\d+)\b',subj) or re.search(r'(?:Weekly Thing #?|WT)(\d+)\b',base)
    bysubj=[k for k,v in issues.items() if v['subject'].strip()==subj.strip()]
    if '2^8' in subj or '2^8' in base: issue='256'; how='number(2^8)'
    elif 'Special Thing #140' in subj: issue='140-special'; how='subject'
    elif len(bysubj)==1: issue=bysubj[0]; how='subject'
    elif mm and not subj.startswith('Weekly Thing for'): issue=mm.group(1); how='number'
    else:
        mm=re.search(r'Weekly Thing for (\w+ \d+, \d{4})',subj)
        if mm:
            d=datetime.datetime.strptime(mm.group(1),'%B %d, %Y').date().isoformat()
            c=bydate.get(d,[])
            if len(c)==1: issue=c[0]; how='date'
            else: how=f'date {d} cand {c}'
    h=m.get_body(preferencelist=('html',))
    emails.append(dict(file=f,base=base,subject=subj,date=dt.isoformat() if dt else None,issue=issue,how=how,html=bool(h),dup=base.endswith(' 2.eml')))
json.dump(dict(issues=issues,emails=emails),open('/tmp/wtq/audit/inventory.json','w'),indent=1,ensure_ascii=False)
mapped={}
for e in emails:
    if e['issue']: mapped.setdefault(e['issue'],[]).append(e['base'])
print('emails',len(emails),'mapped issues',len(mapped))
for e in emails:
    if not e['issue']: print('UNMAPPED',e['base'],e['subject'],e['how'])
print('dups',{k:v for k,v in mapped.items() if len(v)>1})
nums=sorted([k for k in issues], key=lambda x:(float(x.split('-')[0]), x))
print('no email:',[k for k in nums if k not in mapped])
print('nohtml',[e['base'] for e in emails if not e['html']])
# check subject vs archive subject date consistency
for e in emails:
    if e['issue'] and e['issue'] in issues:
        ad=issues[e['issue']]['date']; ed=(e['date'] or '')[:10]
        if ad and ed and abs((datetime.date.fromisoformat(ad)-datetime.date.fromisoformat(ed)).days)>3:
            print('DATE MISMATCH',e['issue'],ad,ed,e['base'])
