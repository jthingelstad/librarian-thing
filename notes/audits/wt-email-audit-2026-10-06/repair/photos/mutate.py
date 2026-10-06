"""Plant one fault at a time in the working tree, run the validator, restore. Each must fail."""
import re, subprocess
ISS = '/Users/otto/Projects/thingelstad.com/librarian-thing/data/issues/'
def m_cover(t): return t.replace('weekly-thing/40/cover.jpg)', 'weekly-thing/41/cover.jpg)')
def m_word(t): return t.replace(') performing Feeling', ') Feeling', 1)
def m_order(t):
    img = re.search(r'^!\[\]\([^)]+\)\n\n', t, re.M).group(0)
    return t.replace(img, '', 1).replace('My favorite picture from the last week.', img + 'My favorite picture from the last week.', 1)
def m_head(t): return t.replace('## Photo 📷', '## Photos 📷', 1)
def m_drop(t): return re.sub(r'^!\[\]\(https://files\.thingelstad\.com/weekly-thing/45/cover\.jpg\)\n\n', '', t, flags=re.M)
def m_dup(t): return t.replace('![](https://files.thingelstad.com/weekly-thing/24/cover.jpg)', '![](https://files.thingelstad.com/weekly-thing/24/cover.jpg)\n\n![](https://files.thingelstad.com/weekly-thing/24/cover.jpg)')
def m_h5(t):
    img = re.search(r'^!\[Dreaming[^\n]*\n\n', t, re.M).group(0)
    return t.replace(img, '', 1).replace('Dreaming of summer.\nMar 9', 'Dreaming of summer.\n\n' + img + 'Mar 9', 1)
def m_lazy(t): return t.replace('![](https://files.thingelstad.com/weekly-thing/23/cover.jpg)\n\n', '![](https://files.thingelstad.com/weekly-thing/23/cover.jpg)\n', 1)
CASES = [(40, m_cover), (33, m_word), (50, m_order), (39, m_head), (45, m_drop), (24, m_dup), (97, m_h5), (23, m_lazy)]
for n, f in CASES:
    p = f'{ISS}{n}/archive.md'; orig = open(p, encoding='utf-8').read(); bad = f(orig)
    assert bad != orig, (n, f.__name__)
    try:
        open(p, 'w', encoding='utf-8').write(bad)
        r = subprocess.run(['/Users/otto/Projects/thingelstad.com/librarian-thing/.venv/bin/python', '/tmp/wtq/r2/validate_photos.py'], capture_output=True, text=True)
    finally:
        open(p, 'w', encoding='utf-8').write(orig)
    fl = [l for l in r.stdout.splitlines() if l.startswith('FAIL')]
    print('CAUGHT' if r.returncode and fl else 'MISSED', n, f.__name__, '|', '; '.join(fl)[:150])
