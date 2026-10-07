"""Round 7 validator, independent of apply.py: compares each changed issue with git
HEAD (or --base REV) and allows only the approved kinds of change.

Text (links reduced to their words, space before punctuation and 's dropped) may differ only by:
  an image's alt text repeated as its own line, a bare App Store/Amazon line whose URL
  links the next line, the empty Supporting Membership heading plus one of its two rules,
  micropost arrows, WT74's doubled title words, WT58's empty "()", WT77's photo date line.
Links may differ only by: a dead blog permalink (round7/dead-permalinks.json) unlinked or
  moved to a live post in data/blog dated within a day; a bare line's URL becoming a link; a
  Buttondown button becoming a link; the approved new links from the emails.
Front matter and links.json may differ only by word_count, which must equal count_words."""
import datetime, glob, json, re, subprocess, sys, yaml
from collections import Counter
from pathlib import Path
from librarian_core.links import count_words

base = sys.argv[sys.argv.index("--base") + 1] if "--base" in sys.argv else "HEAD"
here = Path(__file__).parent
dead = {(int(n), p) for n, ps in json.load(open(here / "dead-permalinks.json")).items() for p in ps}
live = set()
for f in glob.glob("data/blog/posts/**/*.md", recursive=True):
    m = re.search(r'^url:\s*["\']?https?://[^/]+(/\S+?)["\']?\s*$', open(f).read(), re.M)
    if m: live.add(m.group(1))
NEW_LINKS = {(24, "https://micro.blog"), (49, "https://micro.blog"), (26, "https://minnestar.org"), (35, "https://shawnblanc.net")}
LINK = re.compile(r"\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)")

def split(t):
    i = t.index("\n---\n", 3) + 1; return t[3:i], t[i + 3:]
def links(b): return [(m.group(1), m.group(2)) for m in LINK.finditer(b) if not b[max(0, m.start() - 1)] == "!"]
def plain(b):
    b = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", b)
    b = LINK.sub(lambda m: m.group(1), b)
    b = re.sub(r'<buttondown-button[^>]*>([^<]*)</buttondown-button>', r"\1", b)
    return re.sub(r"\s+([.,:;!?]|['’]s\b)", r"\1", b)
def toks(b): return re.findall(r"\S+", plain(b))

def near(a, b):
    """Two permalinks dated within a day (micro.blog dates some posts by UTC)."""
    da, db = (datetime.date(*map(int, x.split("/")[1:4])) for x in (a, b)); return abs((da - db).days) <= 1
fail = []
def bad(n, msg): fail.append(f"WT{n}: {msg}")
changed = subprocess.check_output(["git", "diff", "--name-only", base, "--", "data/issues"], text=True).split()
issues = sorted({int(p.split("/")[2]) for p in changed})
for n in issues:
    old = subprocess.check_output(["git", "show", f"{base}:data/issues/{n}/archive.md"], text=True)
    new = Path(f"data/issues/{n}/archive.md").read_text(encoding="utf-8")
    ofm, ob = split(old); nfm, nb = split(new)
    # --- front matter and links.json: word_count only
    fo, fn = yaml.safe_load(ofm), yaml.safe_load(nfm)
    if fn.get("word_count") != count_words(nb): bad(n, "word_count is not count_words(body)")
    if dict(fo, word_count=0) != dict(fn, word_count=0): bad(n, "front matter changed beyond word_count")
    lo = json.loads(subprocess.check_output(["git", "show", f"{base}:data/issues/{n}/links.json"], text=True))
    ln = json.loads(Path(f"data/issues/{n}/links.json").read_text(encoding="utf-8"))
    if dict(lo, word_count=0) != dict(ln, word_count=0) or ln["word_count"] != fn["word_count"]: bad(n, "links.json changed beyond word_count")
    # --- allowed text removals, derived from the OLD body only
    ol = ob.split("\n"); allowed = Counter()
    alts = set(re.findall(r"!\[([^\]]+)\]\(", ob))
    for i, l in enumerate(ol):
        if l.strip() in alts and not l.startswith("!"): allowed.update(toks(l))                       # alt text as a line
        m = re.fullmatch(r"(https?://\S*(?:apple\.com|amazon\.com)\S*)", l.strip())
        if m:
            nxt = next((x for x in ol[i + 1:] if x.strip()), "")
            if f"]({m.group(1)})" in nxt or nxt.endswith(" ()"): allowed.update(toks(l))              # bare line
        if l == "## Supporting Membership": allowed.update(toks(l) + ["---"])
        if l.endswith(" ()"): allowed["()"] += 1
    allowed["→"] += ob.count("[→](")
    if n == 74: allowed.update("The design and implementation of modern column-oriented".split())
    added_ok = Counter("Oct 20, 2018 at 12:40 PM".split()) if n == 77 else Counter()
    to, tn = Counter(toks(ob)), Counter(toks(nb))
    gone, extra = to - tn, tn - to
    if gone - allowed: bad(n, f"words lost: {dict(gone - allowed)}")
    if extra - added_ok: bad(n, f"words added: {dict(extra - added_ok)}")
    if n == 77 and "\nOct 20, 2018 at 12:40 PM\n300 Eagle Dr, Park Rapids MN\n" not in nb: bad(n, "photo date not in the photo block")
    # order: removing the allowed tokens from old must give new exactly
    seq_o = toks(ob); seq_n = toks(nb)
    import difflib
    for op, a1, a2, b1, b2 in difflib.SequenceMatcher(None, seq_o, seq_n, autojunk=False).get_opcodes():
        if op in ("replace",) and not (n == 77 or n == 58): bad(n, f"reworded: {seq_o[a1:a2][:8]} -> {seq_n[b1:b2][:8]}")
        if op == "insert" and n != 77: bad(n, f"inserted: {seq_n[b1:b2][:8]}")
    # --- links
    lo_, ln_ = Counter(u for _, u in links(ob)), Counter(u for _, u in links(nb))
    for u, k in (lo_ - ln_).items():
        p = re.sub(r"^https?://www\.thingelstad\.com", "", u)
        if not ((n, p) in dead): bad(n, f"link lost: {u} x{k}")
    for u, k in (ln_ - lo_).items():
        p = re.sub(r"^https?://www\.thingelstad\.com", "", u)
        if (n, u) in NEW_LINKS: continue
        if re.match(r"https?://www\.thingelstad\.com/", u) and p in live and any(d[0] == n and near(d[1], p) for d in dead): continue
        if re.search(rf"(?m)^{re.escape(u)}$", ob): continue                                         # bare line -> link
        if f'href="{u}"' in ob and "buttondown-button" in ob: continue
        bad(n, f"link added: {u} x{k}")
    for _, u in links(nb):
        p = re.sub(r"^https?://www\.thingelstad\.com", "", u)
        if (n, p) in dead: bad(n, f"dead permalink still linked: {p}")
    for t, u in set(links(nb)) - set(links(ob)):
        if not t.strip() or t.startswith((",", " ")) or t.endswith(" "): bad(n, f"odd anchor [{t}]")
    trail = lambda b: sum(l != l.rstrip() for l in b.split("\n"))
    if trail(nb) > trail(ob): bad(n, "an edit left trailing whitespace")
    if re.search(r"\S  +\S", nb) and len(re.findall(r"\S  +\S", nb)) > len(re.findall(r"\S  +\S", ob)): bad(n, "an edit left a double space")
    if "buttondown-button" in nb: bad(n, "buttondown-button left")
    if "## Supporting Membership" in nb: bad(n, "membership heading left")
    if re.search(r"\n---\n\s*\n---\n", nb) and not re.search(r"\n---\n\s*\n---\n", ob): bad(n, "doubled rule created")
    for l in nb.split("\n"):
        if re.fullmatch(r"https?://\S*(apple\.com|amazon\.com)\S*", l.strip()): bad(n, f"bare line left: {l[:60]}")
        if l.endswith(" ()"): bad(n, f"empty () left: {l[:60]}")
missing = {n for n, _ in dead} - set(issues)
if missing: fail.append(f"dead-permalink issues untouched: {sorted(missing)}")
print(f"{len(issues)} issues checked against {base}")
print("\n".join(fail) if fail else "OK: every change is an approved kind"); sys.exit(1 if fail else 0)
