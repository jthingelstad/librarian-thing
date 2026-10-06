import json, os, re, shutil, subprocess, sys
from pathlib import Path
SRC = Path(__file__).resolve().parents[5] / "data/issues"; M = Path("/tmp/wtq/r5/mut")  # M: a clone of the repo at the base commit
def reset():
    subprocess.run(["git", "-C", str(M), "checkout", "-q", "HEAD", "--", "data/issues"], check=True)
    for n in range(2, 53):
        for f in ("archive.md", "metadata.json"):
            shutil.copy(SRC / str(n) / f, M / "data/issues" / str(n) / f)
def edit(n, f, fn):
    p = M / "data/issues" / str(n) / f; p.write_text(fn(p.read_text(encoding="utf-8")), encoding="utf-8")
def run(): return subprocess.run([sys.executable, str(Path(__file__).with_name("validate.py"))], cwd=M, env={**os.environ, "WTQ_LT": str(M)}, capture_output=True, text=True)
def orig(n, f): return subprocess.run(["git", "-C", str(M), "show", f"HEAD:data/issues/{n}/{f}"], capture_output=True, text=True).stdout
cases = {
 "clean": None,
 "extra content line deleted": lambda: edit(30, "archive.md", lambda t: (lambda i: t[:i] + t[i:].split("\n", 2)[2])(t.index("\n---", 3) + 4)),
 "blurb kept (heading only removed)": lambda: edit(25, "archive.md", lambda t: (lambda o: o[o.index("\n---", 3) + 4:])(orig(25, "archive.md")).replace("## Promotion 🎁\n\n", "", 1).join([t[:t.index("\n---", 3) + 4], ""])),
 "WT2-52 section left whole": lambda: edit(44, "archive.md", lambda t: orig(44, "archive.md")),
 "Give Back touched": lambda: edit(60, "archive.md", lambda t: re.sub(r"## Give Back 🎁\n", "", t, count=1)),
 "doubled rule": lambda: edit(38, "archive.md", lambda t: t.replace("\n---\n", "\n---\n\n---\n", 1)),
 "WT23 cover cleared": lambda: edit(23, "archive.md", lambda t: re.sub(r"^image: .*$", "image: ''", t, count=1, flags=re.M)),
 "WT12 cover left": lambda: (edit(12, "archive.md", lambda t: re.sub(r"^image: ''$", "image: x", t, count=1, flags=re.M) if False else t), edit(12, "metadata.json", lambda t: orig(12, "metadata.json"))),
 "metadata other key": lambda: edit(5, "metadata.json", lambda t: t.replace('"subject": "', '"subject": "X', 1)),
 "body word changed": lambda: edit(47, "archive.md", lambda t: t.replace(" the ", " a ", 1)),
 "logo line left (headless)": lambda: edit(40, "archive.md", lambda t: t.replace("\n### [OpenTerm]", "\nhttps://www.eff.org\n\n### [OpenTerm]", 1)),
 "cover in body": lambda: edit(10, "archive.md", lambda t: t + "\n![](https://x/cb692d4b-a464-4126.jpg)\n"),
}
bad = 0
for name, mut in cases.items():
    reset()
    if mut: mut()
    r = run(); ok = (r.returncode == 0) == (mut is None)
    bad += not ok
    print("PASS" if ok else "MISS", name, "|", (r.stdout.strip().split("\n")[0])[:110])
sys.exit(bad)
