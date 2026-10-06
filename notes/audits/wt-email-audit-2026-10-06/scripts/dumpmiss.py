import json,collections,re
R=json.load(open('/tmp/wtq/audit/results.json'))['results']
c=collections.Counter()
for k,v in R.items():
    for m in v['missing_sentences']: c[re.sub(r'\d+','#',m['text'][:70])]+=1
for t,n in c.most_common(25): print(n,t)
print('=====')
for k,v in R.items():
    for m in v['missing_sentences']+v['altered_sentences']:
        print(k, m['cov'], m['text'][:250])
