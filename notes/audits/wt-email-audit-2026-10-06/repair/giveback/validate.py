"""Independent check of the spotlight removal against git HEAD (or WTQ_BASE).
Run from librarian-thing (or WTQ_LT)."""
import yaml, difflib, json, os, re, subprocess, sys
from librarian_core.links import extract_links, count_words
from pathlib import Path
LT = Path(os.environ.get("WTQ_LT", ".")); BASE = os.environ.get("WTQ_BASE", "HEAD")
ORG = re.compile(r"(eff\.org|creativecommons\.org|minnestar\.org|wikitribune\.com|archive\.org|letsencrypt\.org|wikimediafoundation\.org|hackthegap\.com|tinyletterapp\.com/.*25192a65)")
COVER = re.compile(r"cb692d4b-a464|25192a65-96d3")
errs = []
def E(*a): errs.append(" ".join(map(str, a)))
def old(path): return subprocess.run(["git", "-C", str(LT), "show", f"{BASE}:{path}"], capture_output=True, text=True).stdout
def fm_body(t):
    i = t.index("\n---", 3) + 4; return t[:i], t[i:]

# 1. only the expected files changed (word_count/links may change in archive.md/links.json)
changed = subprocess.run(["git", "-C", str(LT), "diff", "--name-only", BASE, "--", "data/issues"], capture_output=True, text=True).stdout.split()
for f in changed:
    m = re.match(r"data/issues/(\d+)/(archive\.md|metadata\.json|links\.json)$", f)
    if not m or not 53 <= int(m.group(1)) <= 112: E("unexpected change", f)
    elif m.group(2) == "metadata.json": E("metadata.json changed", f)

for n in range(53, 113):
    a = f"data/issues/{n}/archive.md"
    ofm, ob = fm_body(old(a)); nfm, nb = fm_body((LT / a).read_text(encoding="utf-8"))
    ol, nl = ob.split("\n"), nb.split("\n")
    # 2. body: deletions only
    sm = difflib.SequenceMatcher(None, ol, nl, autojunk=False)
    deleted = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal": continue
        if op != "delete": E(n, "body has", op, ol[i1:i2][:2], nl[j1:j2][:2]); continue
        deleted += ol[i1:i2]
    # 3. deleted lines are the spotlight: heading, a logo, a rule, or a blurb naming an org
    real = [l for l in deleted if l.strip()]
    for l in real:
        if not (l.startswith("## Give Back") or l.strip() == "---" or ORG.search(l)):
            E(n, "deleted a non-spotlight line:", l[:90])
    if not any(ORG.search(l) and len(l) > 80 for l in real): E(n, "no blurb deleted")
    if sum(l.strip() == "---" for l in real) > 1: E(n, "deleted more than one rule")
    # 4. nothing of the spotlight left
    for i, l in enumerate(nl):
        if l.startswith("#") and ("Promotion" in l or "🎁" in l or "Give Back" in l): E(n, "spotlight heading left", i)
        if re.match(r"^\s*https?://(www\.)?(eff|archive|letsencrypt|creativecommons|minnestar|wikitribune|wikimediafoundation|hackthegap)\.(org|com)\S*\s*$", l): E(n, "logo URL left", l)
        if ORG.search(l) and re.search(r"(today!\]\(|with a donation\]\(|become-supporter|donortools|LandingPage)", l): E(n, "spotlight blurb left", l[:80])
        if COVER.search(l): E(n, "cover/logo image left in body")
    # 5. no doubled rules and no leftover leading/trailing junk
    prev = None
    for l in nl:
        if not l.strip(): continue
        if l.strip() == "---" and prev == "---": E(n, "doubled --- rule")
        prev = l.strip()
    # 6. front matter: every key as before except word_count/links
    of, nf = yaml.safe_load(ofm[3:-4]), yaml.safe_load(nfm[3:-4])
    for k in set(of) | set(nf):
        if k == "links":
            if nf.get(k) != of.get(k) and nf.get(k) != extract_links(nb)["all_curated"]: E(n, "front-matter links neither kept nor regenerated")
            continue
        if k == "word_count":
            if nf.get(k) not in (of.get(k), count_words(nb)): E(n, "word_count neither kept nor recomputed")
            continue
        if of.get(k) != nf.get(k): E(n, "front matter changed:", k)
    lo = json.loads(old(f"data/issues/{n}/links.json")); ln = json.loads((LT / f"data/issues/{n}/links.json").read_text(encoding="utf-8"))
    if {k: x for k, x in lo.items() if k != "word_count"} != {k: x for k, x in ln.items() if k != "word_count"}: E(n, "links.json changed beyond word_count")
    if ln.get("word_count") not in (lo.get("word_count"), count_words(nb)): E(n, "links.json word_count neither kept nor recomputed")
# 7. no cover/logo anywhere in the archive (round 5 holds)
for d in (LT / "data/issues").iterdir():
    for f in d.glob("*"):
        if f.suffix in (".md", ".json") and COVER.search(f.read_text(encoding="utf-8")): E("cover/logo still in", f)
print("\n".join(errs) or "OK: WT53-112 Give Back removed, nothing else touched")
sys.exit(1 if errs else 0)
