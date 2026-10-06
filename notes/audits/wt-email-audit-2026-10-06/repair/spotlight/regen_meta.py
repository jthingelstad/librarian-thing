"""Round 5: recompute word_count, front-matter links/domains and links.json after
the spotlight removal. Front matter is edited textually (entries deleted, word_count
replaced); everything else stays byte-for-byte. Only spotlight links/domains may go.
Issues whose front-matter links were already stale keep them (count only)."""
import json, re, subprocess, sys, yaml
from pathlib import Path
from librarian_core.links import extract_links, extract_domains, count_words
SPOT = r"(eff\.org|creativecommons\.org|minnestar\.org|wikitribune\.com|archive\.org|letsencrypt\.org|wikimediafoundation\.org|hackthegap\.com|donortools\.com|tinyletterapp\.com)$"
def split(t):
    i = t.index("\n---\n", 3) + 1; return t[3:i], t[i + 3:]
def meta(body):
    e = extract_links(body); return e, extract_domains(e["all_curated"]), count_words(body)
def block(lines, key):
    """(start, end) of a top-level list key's item lines."""
    k = lines.index(f"{key}:"); e = k + 1
    while e < len(lines) and (lines[e].startswith("- ") or lines[e].startswith("  ")): e += 1
    return k + 1, e
write = "--write" in sys.argv
for n in [int(a) for a in sys.argv[1:] if a.isdigit()]:
    d = Path(f"data/issues/{n}")
    _, old_body = split(subprocess.check_output(["git", "show", f"HEAD:data/issues/{n}/archive.md"], text=True))
    fm_text, body = split((d / "archive.md").read_text(encoding="utf-8"))
    if body == old_body: continue
    eo, do, wo = meta(old_body); en, dn, wn = meta(body)
    fm = yaml.safe_load(fm_text)
    gone = set(do) - set(dn)
    assert not set(dn) - set(do) and all(re.search(SPOT, g) for g in gone), (n, gone)
    fm_sync = fm.get("links") == eo["all_curated"]
    lp = d / "links.json"; lj = json.loads(lp.read_text(encoding="utf-8"))
    lj_sync = lj["notable_links"] == eo["notable"] and lj["briefly_links"] == eo["briefly"] and lj.get("domains") == do
    if not fm_sync: assert not [x for x in fm.get("links") or [] if re.search(SPOT, x.get("domain", ""))], n
    if not lj_sync: assert not [x for x in lj["notable_links"] + lj["briefly_links"] if re.search(SPOT, x.get("domain", ""))] and not [x for x in lj.get("domains") or [] if re.search(SPOT, x)], n
    lines = fm_text.split("\n")
    removed = []
    if fm_sync and eo["all_curated"] != en["all_curated"]:
        s, e = block(lines, "links")
        starts = [i for i in range(s, e) if lines[i].startswith("- ")]
        chunks = [lines[a:b] for a, b in zip(starts, starts[1:] + [e])]
        parsed = [yaml.safe_load("\n".join(c))[0] for c in chunks]
        assert parsed == eo["all_curated"], f"{n}: chunking disagrees"
        keep, j = [], 0
        for c, p in zip(chunks, parsed):
            if j < len(en["all_curated"]) and p == en["all_curated"][j]: keep.append(c); j += 1
            else: removed.append(p)
        assert j == len(en["all_curated"]), f"{n}: new links not a subsequence"
        assert all(re.search(SPOT, p.get("domain", "")) for p in removed), (n, [p.get("url") for p in removed])
        lines = lines[:s] + [l for c in keep for l in c] + lines[e:]
    # front-matter domains: drop the ones no link names any more
    fm_dom = fm.get("domains") or []
    drop = [x for x in fm_dom if x in gone]
    if drop:
        s, e = block(lines, "domains")
        items = lines[s:e]; assert all(l.startswith("- ") for l in items) and [yaml.safe_load(l[2:]) for l in items] == fm_dom, n
        lines = lines[:s] + [l for l in items if yaml.safe_load(l[2:]) not in drop] + lines[e:]
    hits = [i for i, l in enumerate(lines) if l.startswith("word_count: ")]; assert len(hits) == 1, n
    lines[hits[0]] = f"word_count: {wn}"
    new_fm = "\n".join(lines)
    want = dict(fm, word_count=wn)
    if fm_sync: want["links"] = en["all_curated"]
    if drop: want["domains"] = [x for x in fm_dom if x not in drop]
    assert yaml.safe_load(new_fm) == want, f"{n}: textual edit does not parse to the intended front matter"
    print(n, "words", wo, "->", wn, "| fm links", f"-{len(removed)}" if fm_sync else "STALE kept",
          "| fm domains -", ",".join(drop) or "none", "| links.json", "regen" if lj_sync else "count only")
    if write:
        (d / "archive.md").write_text("---" + new_fm + "---" + body, encoding="utf-8")
        if lj_sync: lj.update(notable_links=en["notable"], briefly_links=en["briefly"], domains=dn)
        lj["word_count"] = wn
        lp.write_text(json.dumps(lj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
