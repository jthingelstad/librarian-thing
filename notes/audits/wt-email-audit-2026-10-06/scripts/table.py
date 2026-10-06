import json
D=json.load(open('results.json')); R=D['results']
print(json.dumps(D['dups'],ensure_ascii=False)[:800])
print('iss miss(runs) alt eo | anc ex drift unl miss | hmiss | eimg aimg nameMiss | ebq ok dem bqmiss | bare glued')
for k,v in R.items():
    ei=v['email_imgs']; ai=v['archive_imgs']
    print(k, f"{len(v['missing_sentences'])}({len(v['missing_runs'])}) {len(v['altered_sentences'])} {len(v['email_only_sentences'])} | {v['anchors_total']} {v['anchors_exact']} {len(v['anchors_drift'])} {len(v['anchors_unlinked'])} {len(v['anchors_missing'])} | {len(v['heads_missing'])} | {ei.get('photo',0)}/{ei.get('logo',0)}/{ei.get('icon/cover',0)} {ai.get('photo',0)}/{ai.get('logo',0)}/{ai.get('icon/cover',0)} {len(v['img_missing_by_name'])} | {v['email_bq']} {v['bq_ok']} {len(v['bq_demoted'])} {len(v['bq_missing'])} | {len(v['bare_url_lines'])} {len(v['glued_quotes'])}")
