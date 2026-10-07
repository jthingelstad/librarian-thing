"""Round 8: the last three alt-text caption lines. Approved by Jamie 2026-10-07: "remove
the repeated alt-text caption lines in WT98, WT117 and WT130 and re-render those issues'
audio". Each line repeats the weekly photo's alt text above its date; the sent email
has it only as alt text. Same edit as round 7's captions: the exact old text must match
once. Then ../round7/regen_meta.py recomputes word_count. Run from librarian-thing."""
import sys
from pathlib import Path

write = "--write" in sys.argv
for n, cap, date in [
    (98, "Koala at the Healesville Sanctuary in Australia.", "Mar 20, 2019 at 10:15 PM"),
    (117, "Symmetric Stairs.", "Sep 13, 2019 at 3:02 PM"),
    (130, "Little KLM houses filled with booze.", "Nov 17, 2019 at 1:48 AM")]:
    p = Path(f"data/issues/{n}/archive.md"); t = p.read_text()
    old, new = f"\n\n{cap}\n{date}\n", f"\n\n{date}\n"
    assert t.count(old) == 1, (n, t.count(old))
    assert f"![{cap}](" in t, n   # the photo keeps it as alt text
    print(f"WT{n}: drop caption line {cap!r}")
    if write: p.write_text(t.replace(old, new))
