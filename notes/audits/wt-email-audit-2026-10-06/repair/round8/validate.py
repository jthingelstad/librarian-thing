"""Round 8 validator, independent of apply.py. Against --base (default HEAD): only
WT98/117/130 changed; each body lost exactly one line, which is the alt text of an
image in that issue and sits directly above a "Mon D, YYYY at H:MM AM/PM" date line;
nothing else in the body moved; front matter and links.json differ only in word_count,
which equals count_words of the new body. Run from librarian-thing."""
import json, re, subprocess, sys
from pathlib import Path
from librarian_core.links import count_words

base = sys.argv[sys.argv.index("--base") + 1] if "--base" in sys.argv else "HEAD"
def split(t):
    i = t.index("\n---\n", 3) + 1; return t[3:i], t[i + 3:]
def show(p): return subprocess.check_output(["git", "show", f"{base}:{p}"], text=True)
DATE = re.compile(r"^[A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M$")
fail = []
changed = set(subprocess.check_output(["git", "diff", "--name-only", base], text=True).split())
want = {f"data/issues/{n}/{f}" for n in (98, 117, 130) for f in ("archive.md", "links.json")}
if changed & {p for p in changed if p.startswith("data/")} != want:
    fail.append(f"data files changed: {sorted(p for p in changed if p.startswith('data/'))}")
for n in (98, 117, 130):
    of, ob = split(show(f"data/issues/{n}/archive.md"))
    nf, nb = split(Path(f"data/issues/{n}/archive.md").read_text())
    ol, nl = ob.split("\n"), nb.split("\n")
    gone = [i for i in range(len(ol)) if ol[:i] + ol[i + 1:] == nl]
    if len(gone) != 1: fail.append(f"WT{n}: body is not the old body minus one line"); continue
    i = gone[0]; line = ol[i]
    if f"![{line}](" not in ob: fail.append(f"WT{n}: dropped line {line!r} is not an image's alt text")
    if not DATE.match(ol[i + 1]): fail.append(f"WT{n}: dropped line is not above a date line")
    if f"![{line}](" not in nb: fail.append(f"WT{n}: the photo lost its alt text")
    wc = count_words(nb)
    if re.sub(r"(?m)^word_count: \d+$", "", of) != re.sub(r"(?m)^word_count: \d+$", "", nf) or f"\nword_count: {wc}\n" not in "\n" + nf:
        fail.append(f"WT{n}: front matter changed beyond word_count={wc}")
    oj, nj = json.loads(show(f"data/issues/{n}/links.json")), json.loads(Path(f"data/issues/{n}/links.json").read_text())
    if {**oj, "word_count": None} != {**nj, "word_count": None} or nj.get("word_count") != wc:
        fail.append(f"WT{n}: links.json changed beyond word_count={wc}")
    print(f"WT{n}: dropped {line!r} above {ol[i + 1]!r}; word_count {wc}")
print("\n".join(fail) or "OK"); sys.exit(1 if fail else 0)
