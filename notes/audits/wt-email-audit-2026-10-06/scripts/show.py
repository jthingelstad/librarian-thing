import json,sys
R=json.load(open('results.json'))['results']
lo,hi=float(sys.argv[1]),float(sys.argv[2]); fields=sys.argv[3].split(',')
for k,v in R.items():
    n=float(k.split('-')[0])
    if not (lo<=n<=hi): continue
    for f in fields:
        val=v[f]
        if val: print(k,f,json.dumps(val,ensure_ascii=False)[:700])
