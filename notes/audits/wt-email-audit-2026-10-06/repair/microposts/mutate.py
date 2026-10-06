"""Plant faults in a repaired issue; the validator must catch every one."""
import re, sys
sys.argv = ['x']
import validate as V

N = 48
path = f'{V.LT}/data/issues/{N}/archive.md'
good = open(path, encoding='utf-8').read()
U = 'https://cdn.uploads.micro.blog/890/2018/'
T = ['7942125c64.jpg', '5ff11842bd.jpg', 'f47aff8f1a.jpg', '2fba00047e.jpg']

def line_of(t, b): return next(i for i, l in enumerate(t.split('\n')) if b in l)
def edit(fn):
    ls = good.split('\n'); fn(ls); return '\n'.join(ls)

def move_to_other_post(ls):
    i = line_of(good, T[2]); x = ls.pop(i); j = line_of(good, T[3]) - 1; ls.insert(j + 1, x)
def swap(ls):
    i, j = line_of(good, T[0]), line_of(good, T[1]); ls[i], ls[j] = ls[j], ls[i]
def drop(ls): ls.pop(line_of(good, T[2]))
def dup(ls): i = line_of(good, T[0]); ls.insert(i, ls[i])
def host(ls): i = line_of(good, T[2]); ls[i] = ls[i].replace('cdn.uploads.micro.blog/890', 'www.thingelstad.com/uploads')
def year(ls): i = line_of(good, T[2]); ls[i] = ls[i].replace('/2018/', '/2017/')
def alt(ls): i = line_of(good, T[2]); ls[i] = ls[i].replace('![]', '![photo]')
def glue(ls): i = line_of(good, T[2]); ls.pop(i - 1)
def word(ls): i = line_of(good, 'Family selfie'); ls[i] = ls[i].replace('Family selfie', 'Family photo')
def fm(ls): i = next(i for i, l in enumerate(ls) if l.startswith('word_count:')); ls[i] = 'word_count: 1'
def stray(ls): i = line_of(good, T[0]); ls.insert(i, 'Look at this!')
def above(ls):
    i = line_of(good, T[2]); x = ls.pop(i); ls.pop(i)  # image + its trailing blank
    h = max(k for k in range(i) if ls[k].startswith('[Friday @ 7:50 PM]')); ls.insert(h, ''); ls.insert(h, x)
def kept_again(ls):
    i = line_of(good, T[2]); ls.insert(i, '![](https://files.thingelstad.com/weekly-thing/48/cover.jpg)')
def promo(ls):
    i = next(k for k, l in enumerate(ls) if l.startswith('## Promotion')); x = ls.pop(line_of(good, T[2])); ls.insert(i + 1, ''); ls.insert(i + 2, x)

caught = 0; faults = [move_to_other_post, swap, drop, dup, host, year, alt, glue, word, fm, stray, above, kept_again, promo]
try:
    for f in faults:
        open(path, 'w', encoding='utf-8').write(edit(f)); V.fails.clear(); V.check(N)
        print(('caught ' if V.fails else 'MISSED ') + f.__name__, '|', V.fails[0][:100] if V.fails else '')
        caught += bool(V.fails)
finally:
    open(path, 'w', encoding='utf-8').write(good)
print(f'{caught}/{len(faults)} caught')
