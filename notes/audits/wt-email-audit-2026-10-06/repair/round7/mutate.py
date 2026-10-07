"""Round 7 mutation test: plant one fault at a time in a scratch clone holding the
round's edits and require validate.py or anchors.py to fail on it. Run from
librarian-thing with the round's edits in the working tree."""
import json, re, shutil, subprocess, sys
from pathlib import Path
SRC = Path.cwd(); S = Path("/tmp/wtq/r7/mut"); PY = str(SRC / ".venv/bin/python")
R = "notes/audits/wt-email-audit-2026-10-06/repair/round7"
shutil.rmtree(S, ignore_errors=True)
subprocess.run(["git", "clone", "-q", "--local", str(SRC), str(S)], check=True)
shutil.copytree(SRC / "data/issues", S / "data/issues", dirs_exist_ok=True)
shutil.copytree(SRC / R, S / R, dirs_exist_ok=True)
shutil.rmtree(S / "data/blog"); shutil.copytree(SRC / "data/blog", S / "data/blog")
def body_sub(n, old, new, f="archive.md"):
    p = S / f"data/issues/{n}/{f}"; t = p.read_text(); assert t.count(old) >= 1, (n, old); p.write_text(t.replace(old, new, 1))
FAULTS = {
    "word dropped in an anchor fix": lambda: body_sub(118, "over last weekend", "over weekend"),
    "word added": lambda: body_sub(98, "was a highly anticipated", "was a really highly anticipated"),
    "dead permalink left linked": lambda: body_sub(8, "- Going iPad only on this vacation! 🚫💻", "- [Going iPad only on this vacation! 🚫💻](http://www.thingelstad.com/2017/06/24/going-ipad-only.html)"),
    "relinked to a post that does not exist": lambda: body_sub(39, "/2018/01/27/074734.html", "/2018/01/27/074735.html"),
    "relinked to a live post on another day": lambda: body_sub(41, "/2018/02/12/we-got-tyler.html", "/2018/01/27/183307.html"),
    "anchor URL swapped": lambda: body_sub(84, "(https://en.wikipedia.org/wiki/David_Mamet)", "(https://en.wikipedia.org/wiki/Glengarry_Glen_Ross_(film))"),
    "external link removed": lambda: body_sub(24, "[Bitmark](https://bitmark.com)", "Bitmark"),
    "anchor not the email's words": lambda: body_sub(30, "A [FOSS](", "[A FOSS]("),
    "anchor over the wrong words": lambda: body_sub(118, "That same day [Stallman resigned from MIT](", "That [same day Stallman resigned from MIT]("),
    "wrong word_count": lambda: body_sub(30, "word_count: ", "word_count: 1"),
    "front matter edited": lambda: body_sub(57, "\ndescription: ", "\ndescription: X "),
    "links.json edited": lambda: (lambda p: p.write_text(p.read_text().replace('"domain": "', '"domain": "x', 1)))(S / "data/issues/57/links.json"),
    "photo location line deleted": lambda: body_sub(62, "\nWarsaw, MN\n", "\n"),
    "caption that is not alt text deleted": lambda: body_sub(110, "Giant slip-n-slide in Newton Sledding Hill in South Minneapolis celebrating a hot summers day! ☀️💦\n\n", ""),
    "photo date in the wrong place": lambda: (body_sub(77, "Oct 20, 2018 at 12:40 PM\n300 Eagle", "300 Eagle"), body_sub(77, "## Notable Links 📌", "Oct 20, 2018 at 12:40 PM\n\n## Notable Links 📌")),
    "buttondown button left": lambda: body_sub(339, "[eBook on Gumroad](https://jthingelstad.gumroad.com/l/yearly-thing-2025)", '<buttondown-button align="center" href="https://jthingelstad.gumroad.com/l/yearly-thing-2025">eBook on Gumroad</buttondown-button>'),
    "doubled rule left": lambda: body_sub(331, "\n---\n\n## Briefly", "\n---\n\n---\n\n## Briefly"),
    "membership heading left": lambda: body_sub(320, "\n---\n", "\n---\n\n## Supporting Membership\n\n---\n"),
    "bare App Store line left": lambda: body_sub(40, "### [OpenTerm]", "https://itunes.apple.com/us/app/openterm/id1323205755?mt=8&uo=4&at=1001lxyE&ct=thingelstad_com\n\n### [OpenTerm]"),
    "Now Reading title left unlinked": lambda: body_sub(64, "[Measure What Matters: How Google, Bono, and the Gates Foundation Rock the World with OKRs](https://www.amazon.com/Measure-What-Matters-Google-Foundation/dp/0525536221/)", "Measure What Matters: How Google, Bono, and the Gates Foundation Rock the World with OKRs ()"),
    "a fix never applied (WT27 book club)": lambda: body_sub(27, "I’m excited that [my book club](https://rwbook.club)", "[I’m excited that my book club](https://rwbook.club)"),
    "unlinked arrow left with its space": lambda: body_sub(28, "favorite images.", "favorite images. "),
    "a plain line deleted": lambda: body_sub(36, "Joel Spolsky", "Joel"),
}
clean = S / "data/issues"; snap = Path("/tmp/wtq/r7/mut-snap"); shutil.rmtree(snap, ignore_errors=True); shutil.copytree(clean, snap)
def check():
    a = subprocess.run([PY, f"{R}/validate.py"], cwd=S, capture_output=True, text=True)
    b = subprocess.run([PY, f"{R}/anchors.py"], cwd=S, capture_output=True, text=True)
    return a.returncode, b.returncode, (a.stdout + b.stdout).strip().split("\n")
rc = check(); assert rc[:2] == (0, 0), rc
missed = []
for name, f in FAULTS.items():
    shutil.rmtree(clean); shutil.copytree(snap, clean); f()
    va, an, out = check()
    caught = va or an
    print(("CAUGHT " if caught else "MISSED ") + name + ("  | " + next((l for l in out if l.startswith("WT") or "untouched" in l), "") if caught else ""))
    if not caught: missed.append(name)
print(f"{len(FAULTS) - len(missed)}/{len(FAULTS)} caught"); sys.exit(1 if missed else 0)
