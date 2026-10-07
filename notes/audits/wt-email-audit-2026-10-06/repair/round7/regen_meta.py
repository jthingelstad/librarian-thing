"""Round 7: recompute word_count, front-matter links/domains and links.json for every
issue whose body changed against HEAD. Front matter is edited textually: unchanged
link entries keep their exact lines, changed or new ones are dumped in the same style,
and the result must parse to exactly the intended front matter. Front matter or
links.json that was already out of step with its body keeps its links (count only)."""
import json, subprocess, sys, yaml
from pathlib import Path
from librarian_core.links import extract_links, extract_domains, count_words

def split(t):
    i = t.index("\n---\n", 3) + 1; return t[3:i], t[i + 3:]
def meta(body):
    e = extract_links(body); return e, extract_domains(e["all_curated"]), count_words(body)
def block(lines, key):
    k = lines.index(f"{key}:"); e = k + 1
    while e < len(lines) and (lines[e].startswith("- ") or lines[e].startswith("  ")): e += 1
    return k + 1, e
def dump(x):
    return yaml.safe_dump([x], allow_unicode=True, sort_keys=False, width=10**6, default_flow_style=False).rstrip("\n").split("\n")

write = "--write" in sys.argv
changed = subprocess.check_output(["git", "diff", "--name-only", "HEAD", "--", "data/issues"], text=True).split()
for n in sorted({int(p.split("/")[2]) for p in changed if p.endswith("archive.md")}):
    d = Path(f"data/issues/{n}")
    _, old_body = split(subprocess.check_output(["git", "show", f"HEAD:data/issues/{n}/archive.md"], text=True))
    fm_text, body = split((d / "archive.md").read_text(encoding="utf-8"))
    eo, do, wo = meta(old_body); en, dn, wn = meta(body)
    fm = yaml.safe_load(fm_text); lines = fm_text.split("\n"); want = dict(fm, word_count=wn); note = []
    fm_sync = fm.get("links") == eo["all_curated"]
    if fm_sync and eo["all_curated"] != en["all_curated"]:
        s, e = block(lines, "links")
        starts = [i for i in range(s, e) if lines[i].startswith("- ")]
        chunks = [lines[a:b] for a, b in zip(starts, starts[1:] + [e])]
        assert [yaml.safe_load("\n".join(c))[0] for c in chunks] == eo["all_curated"], n
        old = {json.dumps(x, sort_keys=True): c for x, c in zip(eo["all_curated"], chunks)}
        lines = lines[:s] + [l for x in en["all_curated"] for l in old.get(json.dumps(x, sort_keys=True)) or dump(x)] + lines[e:]
        want["links"] = en["all_curated"]; note.append(f"links {len(eo['all_curated'])}->{len(en['all_curated'])}")
    elif not fm_sync and eo["all_curated"] != en["all_curated"]:
        note.append("fm links STALE, kept")
    if fm.get("domains") == do and do != dn:
        s, e = block(lines, "domains"); lines = lines[:s] + [f"- {x}" for x in dn] + lines[e:]
        want["domains"] = dn; note.append(f"domains -{sorted(set(do) - set(dn))} +{sorted(set(dn) - set(do))}")
    elif fm.get("domains") != do and do != dn:
        note.append("fm domains STALE, kept")
    hits = [i for i, l in enumerate(lines) if l.startswith("word_count: ")]; assert len(hits) == 1, n
    lines[hits[0]] = f"word_count: {wn}"
    new_fm = "\n".join(lines)
    assert yaml.safe_load(new_fm) == want, f"{n}: textual edit does not parse to the intended front matter"
    lp = d / "links.json"; lj = json.loads(lp.read_text(encoding="utf-8"))
    lj_sync = lj["notable_links"] == eo["notable"] and lj["briefly_links"] == eo["briefly"] and lj.get("domains") == do
    if lj_sync: lj.update(notable_links=en["notable"], briefly_links=en["briefly"], domains=dn)
    elif eo["all_curated"] != en["all_curated"] or do != dn: note.append("links.json STALE, count only")
    lj["word_count"] = wn
    print(n, "words", wo, "->", wn, "|", "; ".join(note) or "count only")
    if write:
        (d / "archive.md").write_text("---" + new_fm + "---" + body, encoding="utf-8")
        lp.write_text(json.dumps(lj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
