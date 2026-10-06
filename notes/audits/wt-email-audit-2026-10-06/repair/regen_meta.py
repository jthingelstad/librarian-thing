"""Regenerate front-matter links/domains/word_count and links.json from the
body for the given issues; report what changed beyond word_count."""
import json, subprocess, sys, yaml
from pathlib import Path
from librarian_core.links import extract_links, extract_domains, count_words

def split(t):
    i = t.index('---', 3); return t[3:i], t[i + 3:]

def meta(body):
    e = extract_links(body)
    return e, extract_domains(e["all_curated"]), count_words(body)

write = '--write' in sys.argv
for n in [int(a) for a in sys.argv[1:] if a.isdigit()]:
    d = Path(f"data/issues/{n}")
    old_fm, old_body = split(subprocess.check_output(["git", "show", f"HEAD:data/issues/{n}/archive.md"], text=True))
    text = (d / "archive.md").read_text(encoding="utf-8"); fm_text, body = split(text)
    fm = yaml.safe_load(fm_text)
    assert "---\n" + yaml.safe_dump(fm, sort_keys=False, allow_unicode=True, width=1000) == "---" + fm_text, f"{n}: front matter does not round-trip"
    if body == old_body:
        continue  # body untouched: leave its counts as they were
    eo, do, wo = meta(old_body); en, dn, wn = meta(body)
    changed = []
    if eo != en: changed.append("links")
    if do != dn: changed.append("domains")
    print(n, "word_count", fm.get("word_count"), "->", wn, "|", ",".join(changed) or "links unchanged",
          "| fm links were in sync:", fm.get("links") == eo["all_curated"])
    if write:
        assert not changed, f"{n}: the round changed links; regenerate them deliberately"
        lines = ("---" + fm_text).split("\n")
        hits = [i for i, l in enumerate(lines) if l.startswith("word_count: ")]
        assert len(hits) == 1, n
        lines[hits[0]] = f"word_count: {wn}"
        (d / "archive.md").write_text("\n".join(lines) + "---" + body, encoding="utf-8")
        lj_path = d / "links.json"; lj_text = lj_path.read_text(encoding="utf-8")
        lj = json.loads(lj_text); lj["word_count"] = wn
        lj_path.write_text(json.dumps(lj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
