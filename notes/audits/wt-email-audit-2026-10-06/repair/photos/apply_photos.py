"""Restore each WT23-130 weekly photo the archive lost, from the sent email.

The image is the issue's own cover (front-matter `image`, verified pixel-identical
to the email photo by sweep.py), placed where the email places it: right after the
photo heading, or after the paragraph the email puts before it. The alt is the
email's alt, which is usually empty. WT39-41 also lost the heading, so it is
restored from the email, above the caption.
"""
import sys
from bs4 import Comment
from common import *

ISSUES = [int(a) for a in sys.argv[1:] if a.isdigit()] or [23, 24, 25, 26, 28, *range(30, 53), 97, 109]
rows = {r['n']: r for r in json.load(open('/tmp/wtq/r2/photos.json'))}
HEAD = re.compile(r'^## [^\n]*[Pp]hoto(?!graphy)[^\n]*$', re.M)


def email_section(n):
    s = soup_of(n)
    img = s.find('img', src=rows[n]['email_img'])
    head = [h for h in s.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) if re.search('photo', h.get_text(), re.I)][0]
    before, after, seen = [], [], False
    for el in head.find_all_next(string=True):
        hp = el.find_parent(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
        if hp and hp is not head: break
        if isinstance(el, Comment) or hp is head: continue
        if not seen and img in el.find_all_previous('img'): seen = True
        if el.strip(): (after if seen else before).append(el.strip())
    return head.get_text(' ', strip=True), (img.get('alt') or '').strip(), W(' '.join(before)), W(' '.join(after))


def para_words(p):
    return W(A.md_to_text(p))


def apply(n):
    front, body = read(n)
    cover = re.search(r'^image: *(.*)$', front, re.M).group(1).strip().strip('\'"')
    head, alt, before, after = email_section(n)
    line = f"![{alt.replace(']', '')}]({cover})"
    paras = body.split('\n\n')
    m = HEAD.search(body)
    if m:
        hi = next(i for i, p in enumerate(paras) if HEAD.match(p.strip()))
        paras[hi] = f'## {head}'
        at = hi + 1
        if before and n < 53:
            hits = [i for i in range(hi + 1, len(paras)) if para_words(paras[i]) == before]
            if not hits:
                # the email's lead-in shares a paragraph with the date lines (WT109): split it
                for i in range(hi + 1, len(paras)):
                    ls = paras[i].split('\n')
                    k = next((k for k in range(1, len(ls)) if para_words('\n'.join(ls[:k])) == before), None)
                    if k:
                        paras[i:i + 1] = ['\n'.join(ls[:k]), '\n'.join(ls[k:])]
                        hits = [i]
                        break
            assert len(hits) == 1, (n, hits)
            at = hits[0] + 1
        paras.insert(at, line)
    else:
        lead = after[:6]
        at = [i for i, p in enumerate(paras) if para_words(p)[:6] == lead]
        assert len(at) == 1, (n, at)
        paras[at[0]:at[0]] = [f'## {head}', line]
    open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(front + '\n\n'.join(paras))


if __name__ == '__main__':
    for n in ISSUES:
        apply(n)
        print(n, 'ok')
