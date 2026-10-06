"""WT70: drop the line of four raw photo URLs under "Monday @ 7:58 PM".

The email shows those four photos as images, and the archive already has all four as
images in the same post, below the text. The URL line is a second copy, from the post's
text at import. Checks that the line is exactly those four URLs, each one an image of the
same post, before it writes.
"""
import os, re
from common import read, ISS
n = 70
fm, body = read(n); lines = body.split('\n')
i = next(k for k, l in enumerate(lines) if l.startswith('https://www.thingelstad.com/uploads/2018/6ee7517ab7.jpg'))
urls = lines[i].split()
assert len(urls) == 4 and all(re.fullmatch(r'https://www\.thingelstad\.com/uploads/2018/[0-9a-f]{10}\.jpg', u) for u in urls), urls
assert lines[i - 1] == '' and lines[i + 1] == '' and lines[i - 2].startswith('### [Monday @ 7:58 PM]')
nxt = next(k for k in range(i + 1, len(lines)) if lines[k].startswith('### '))
imgs = [os.path.basename(m) for m in re.findall(r'^!\[\]\(([^)]+)\)$', '\n'.join(lines[i + 1:nxt]), re.M)]
assert imgs == [os.path.basename(u) for u in urls], imgs
del lines[i - 1:i + 1]
open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(fm + '\n'.join(lines))
print('WT70: dropped', urls)
