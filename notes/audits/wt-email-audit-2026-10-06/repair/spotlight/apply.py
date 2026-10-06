"""Remove the nonprofit spotlight (## Promotion 🎁) from WT2-52 and clear the
WT2-22 covers. Approved by Jamie 2026-10-06. Run from librarian-thing."""
import json, re, sys
from pathlib import Path

ORGS = r"https?://(www\.)?(archive\.org|eff\.org|letsencrypt\.org)/?$"
HEADLESS = {39, 40, 41}   # spotlight whose heading was lost: logo URL line + blurb between --- rules
COVERS = ("cb692d4b-a464-4126-aaac-e352b7edd7a5", "25192a65-96d3-4b97-ab6b-d324e8bf8d42")
write = "--write" in sys.argv
report = {}

def blank(l): return l.strip() == ""

def remove(lines, start, end):
    """Drop lines[start:end] and the blank run after it; if that leaves two ---
    rules with only blanks between, keep one."""
    while end < len(lines) and blank(lines[end]): end += 1
    out = lines[:start] + lines[end:]
    i = start - 1
    while i >= 0 and blank(out[i]): i -= 1
    if i >= 0 and out[i].strip() == "---" and start < len(out) and out[start].strip() == "---":
        del out[start]
        while start < len(out) and blank(out[start]): del out[start]
    return out

for n in range(2, 53):
    p = Path(f"data/issues/{n}/archive.md")
    text = p.read_text(encoding="utf-8")
    fm_end = text.index("\n---", 3) + 4
    fm, body = text[:fm_end], text[fm_end:]
    lines = body.split("\n")
    removed = []
    while True:
        hits = [i for i, l in enumerate(lines) if l.startswith("## Promotion")]
        if not hits: break
        s = hits[0]
        e = s + 1
        while e < len(lines) and not lines[e].startswith("## ") and lines[e].strip() != "---": e += 1
        removed.append("\n".join(lines[s:e]).strip())
        lines = remove(lines, s, e)
    if n in HEADLESS:
        hits = [i for i, l in enumerate(lines) if re.match(ORGS, l.strip())]
        assert len(hits) == 1, (n, hits)
        s = hits[0]
        assert lines[s - 2].strip() == "---" and blank(lines[s - 1]), n
        e = s + 1
        while e < len(lines) and not lines[e].startswith("## ") and lines[e].strip() != "---": e += 1
        assert lines[e].strip() == "---", n
        removed.append("\n".join(lines[s:e]).strip())
        lines = remove(lines, s, e)
    new_fm = fm
    cover = None
    if n <= 22:
        m = re.search(r"^image: (.*)$", fm, re.M)
        assert m and any(c in m.group(1) for c in COVERS), n
        cover = m.group(1)
        new_fm = fm[:m.start()] + "image: ''" + fm[m.end():]
    new = new_fm + "\n".join(lines)
    if new != text:
        report[n] = {"removed": removed, "cover": cover}
        if write:
            p.write_text(new, encoding="utf-8")
            if cover:
                mp = Path(f"data/issues/{n}/metadata.json")
                md = json.loads(mp.read_text(encoding="utf-8"))
                assert md.get("image") == cover, n
                md["image"] = ""
                mp.write_text(json.dumps(md, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
json.dump(report, open("/tmp/wtq-spotlight-report.json", "w"), indent=1, ensure_ascii=False)
print(len(report), "issues;", sum(len(v["removed"]) for v in report.values()), "sections;",
      sum(1 for v in report.values() if v["cover"]), "covers")
