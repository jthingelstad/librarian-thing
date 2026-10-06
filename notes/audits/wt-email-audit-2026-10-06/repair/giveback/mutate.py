import json, os, re, shutil, subprocess, sys
from pathlib import Path
SRC = Path(__file__).resolve().parents[5] / "data/issues"; M = Path("/tmp/wtq/r6/mut")  # M: a clone of the repo at the base commit
def reset():
    subprocess.run(["git", "-C", str(M), "checkout", "-q", "HEAD", "--", "data/issues"], check=True)
    for n in range(53, 113):
        for f in ("archive.md", "metadata.json", "links.json"):
            shutil.copy(SRC / str(n) / f, M / "data/issues" / str(n) / f)
def edit(n, f, fn):
    p = M / "data/issues" / str(n) / f; p.write_text(fn(p.read_text(encoding="utf-8")), encoding="utf-8")
def run(): return subprocess.run([sys.executable, str(Path(__file__).with_name("validate.py"))], cwd=M, env={**os.environ, "WTQ_LT": str(M)}, capture_output=True, text=True)
def orig(n, f): return subprocess.run(["git", "-C", str(M), "show", f"HEAD:data/issues/{n}/{f}"], capture_output=True, text=True).stdout
cases = {
 "clean": None,
 "extra content line deleted": lambda: edit(70, "archive.md", lambda t: (lambda i: t[:i] + t[i:].split("\n", 2)[2])(t.index("\n---\n", 3) + 4)),
 "blurb kept (heading and logo only removed)": lambda: edit(80, "archive.md", lambda t: t[:t.index("\n---\n", 3) + 4] + (lambda o: o[o.index("\n---\n", 3) + 4:])(orig(80, "archive.md")).replace("## Give Back 🎁\n\nhttps://creativecommons.org\n\n", "", 1)),
 "section left whole": lambda: edit(99, "archive.md", lambda t: orig(99, "archive.md")),
 "Promotion issue touched": lambda: edit(30, "archive.md", lambda t: t.replace(" the ", " a ", 1)),
 "issue past 112 touched": lambda: edit(113, "archive.md", lambda t: t + "\n"),
 "doubled rule": lambda: edit(60, "archive.md", lambda t: t.replace("\n---\n", "\n---\n\n---\n", 2)),
 "front matter key changed": lambda: edit(90, "archive.md", lambda t: re.sub(r"^description: ", "description: X", t, count=1, flags=re.M)),
 "metadata changed": lambda: edit(75, "metadata.json", lambda t: t.replace('"subject": "', '"subject": "X', 1)),
 "body word changed": lambda: edit(101, "archive.md", lambda t: (lambda i: t[:i] + t[i:].replace(" the ", " a ", 1))(t.index("\n---\n", 3) + 4)),
 "front-matter link corrupted": lambda: edit(101, "archive.md", lambda t: t.replace(" the ", " a ", 1)),
 "word_count wrong": lambda: edit(66, "archive.md", lambda t: re.sub(r"^word_count: (\d+)", lambda m: f"word_count: {int(m.group(1)) + 7}", t, count=1, flags=re.M)),
 "logo line left": lambda: edit(57, "archive.md", lambda t: t.replace("\n## Highlighted", "\nhttps://wikimediafoundation.org/\n\n## Highlighted", 1)),
 "links.json link dropped": lambda: edit(88, "links.json", lambda t: (lambda d: json.dumps({**d, "notable_links": d["notable_links"][1:]}, indent=2, ensure_ascii=False) + "\n")(json.loads(t))),
 "links.json word_count wrong": lambda: edit(95, "links.json", lambda t: re.sub(r'"word_count": (\d+)', lambda x: f'"word_count": {int(x.group(1)) + 3}', t)),
 "heading left": lambda: edit(112, "archive.md", lambda t: t.replace("\n## Yet More Links", "\n## Give Back 🎁\n\n## Yet More Links", 1)),
}
bad = 0
for name, mut in cases.items():
    reset()
    if mut: mut()
    r = run(); ok = (r.returncode == 0) == (mut is None)
    bad += not ok
    print("PASS" if ok else "MISS", name, "|", (r.stdout.strip().split("\n")[0])[:110])
sys.exit(bad)
