"""WT61: drop the raw "(https://itty.bitty.site/…)" text left under the now-linked title.

The import wrote the URL as text, wrapped over two lines. Round 3 linked the title to it,
so the text is a second copy. Check: the dropped lines join to exactly "(" + the link's URL + ")".
"""
import re, sys
sys.path.insert(0, '/tmp/wtq/r3')
from common import ISS
p = f'{ISS}61/archive.md'; t = open(p, encoding='utf-8').read(); L = t.split('\n')
k = next(i for i, l in enumerate(L) if l.startswith('[Itty bitty sites]('))
url = re.match(r'\[Itty bitty sites\]\(([^)]+)\)$', L[k]).group(1)
j = next(i for i in range(k + 1, len(L)) if L[i] == 'itty.bitty.site')
assert ''.join(L[k + 1:j]) == f'({url})', 'the lines are not the link URL'
print('drop', j - k - 1, 'lines,', sum(map(len, L[k + 1:j])), 'chars')
if '--write' in sys.argv: open(p, 'w', encoding='utf-8').write('\n'.join(L[:k + 1] + L[j:]))
