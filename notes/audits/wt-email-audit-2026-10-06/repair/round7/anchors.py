"""Round 7 oracle for the link placements. In every issue the round touched (WT1-130,
where the sent emails exist), each link must carry exactly the words a link carried in
the sent email (case, quotes and spacing folded; titles may drop a " | site" suffix).
Micropost arrows and image links are format, not words, and are skipped. A mismatch
passes only if anchors-left.json lists it with a reason, so a reverted or missing fix
fails. Reads the email set from the 2026-10-06 audit (/tmp/wtq/audit)."""
import email, json, re, subprocess, sys
from email import policy
from collections import Counter
from bs4 import BeautifulSoup
from pathlib import Path
LINK = re.compile(r"\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)")   # validate.py's grammar
def split(t):
    i = t.index("\n---\n", 3) + 1; return t[3:i], t[i + 3:]
def links(b): return [(m.group(1), m.group(2)) for m in LINK.finditer(b) if not b[max(0, m.start() - 1)] == "!"]

INV = json.load(open("/tmp/wtq/audit/inventory.json"))
EM = {int(e["issue"]): e["file"] for e in INV["emails"] if e["issue"] is not None and not e["dup"] and str(e["issue"]).isdigit()}
def fold(s): return re.sub(r"\s+", " ", s.replace("’", "'").replace("“", '"').replace("”", '"')).strip(" .,:;!").lower()
def email_anchors(n):
    m = email.message_from_binary_file(open(EM[n], "rb"), policy=policy.default)
    s = BeautifulSoup(m.get_body(("html",)).get_content(), "html.parser")
    return {fold(a.get_text(" ", strip=True)) for a in s.find_all("a")}
LEFT = json.load(open(Path(__file__).with_name("anchors-left.json")))
fail, seen, left = [], 0, set()
for p in subprocess.check_output(["git", "diff", "--name-only", "HEAD", "--", "data/issues"], text=True).split():
    if not p.endswith("archive.md"): continue
    n = int(p.split("/")[2])
    if n > 130 or n not in EM: continue
    _, nb = split(Path(p).read_text())
    ea = email_anchors(n)
    for t, u in links(nb):
        if t == "→" or t.startswith("!["): continue
        seen += 1
        if fold(t) in ea or any(a.startswith(fold(t) + " | ") for a in ea): continue   # titles drop the " | site" suffix
        if f"{n}|{u}" in LEFT: left.add(f"{n}|{u}"); continue
        fail.append(f"WT{n}: [{t}] is not a link's text in the email")
stale = set(k for k in LEFT if not k.startswith("_")) - left
if stale: fail.append(f"anchors-left.json lists links no longer found: {sorted(stale)}")
print(f"{seen} links checked against the sent emails ({len(left)} reviewed leftovers)")
print("\n".join(fail) or "OK: every link carries an email link's words"); sys.exit(1 if fail else 0)
