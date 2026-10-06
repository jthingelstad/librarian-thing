"""Check the weekly-photo restore against the emails, independently of apply_photos.py.

P1 text: with the added image lines (and WT39-41's restored heading) taken out, the
   body is HEAD's body exactly, up to blank-line splits.
P2 one photo: the rendered photo section holds exactly one image, and it is the
   front-matter cover.
P3 pixels: that image is the email's photo (16x16 grey mean diff <= 2, same size).
P4 place: in the render, the email's text before the photo comes before the image
   and the email's text after it comes after.
P5 heading: a restored heading reads as the email's heading.
P6 coverage: every WT23-130 issue whose email has a photo now renders one in its
   photo section, except the listed exceptions.
"""
import io, json, os, re, subprocess, sys, urllib.request
from bs4 import Comment
from PIL import Image, ImageOps
sys.path.insert(0, '/tmp/wtq/r2')
from common import A, ISS, W, read, soup_of

EXCEPT = {29: 'email photo is a dead MailChimp link; no copy anywhere'}
rows = {r['n']: r for r in json.load(open('/tmp/wtq/r2/photos.json'))}
LT = '/Users/otto/Projects/thingelstad.com/librarian-thing'
fails = []
def fail(n, why): fails.append((n, why))

def head_body(n):
    t = subprocess.run(['git', '-C', LT, 'show', f'HEAD:data/issues/{n}/archive.md'], capture_output=True, text=True).stdout
    return t[t.index('---', 3) + 3:]

def fetch(u):
    p = '/tmp/wtq/r2/img/' + re.sub(r'[^\w.]+', '_', u)[-120:]
    if not os.path.exists(p):
        open(p, 'wb').write(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read())
    im = ImageOps.exif_transpose(Image.open(p))
    return im.size, list(im.convert('L').resize((16, 16)).getdata())

def email_parts(n):
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
    return head.get_text(' ', strip=True), W(' '.join(before)), W(' '.join(after))

changed = sorted(int(m) for m in re.findall(r'data/issues/(\d+)/archive\.md',
                 subprocess.run(['git', '-C', LT, 'diff', '--name-only'], capture_output=True, text=True).stdout))
targets = [n for n in range(23, 131) if rows.get(n, {}).get('email_img')]
render = json.loads(subprocess.run(['node', '/tmp/wtq/r2/render_photos.cjs', *[f'{ISS}{n}/archive.md' for n in targets]],
                                   capture_output=True, text=True, check=True).stdout)
for n in changed:
    if n not in targets: fail(n, 'changed but its email has no photo')
for n in targets:
    front, body = read(n)
    cover = re.search(r'^image: *(.*)$', front, re.M).group(1).strip().strip('\'"')
    eh, before, after = email_parts(n)
    secs = [s for s in render[str(n)] if s['heading'] and re.search(r'photo(?!graphy)', s['heading'], re.I)]
    if n in EXCEPT:
        if n in changed: fail(n, 'exception issue was changed')
        continue
    if len(secs) != 1: fail(n, f'{len(secs)} photo sections'); continue
    sec = secs[0]
    if sec['imgs'] != [cover]: fail(n, f'P2 photo section images {sec["imgs"]} != [{cover}]'); continue
    if n in changed and sec['alone'] != [True]: fail(n, 'P2 the photo shares its paragraph with text')
    if n in changed:
        old = head_body(n)
        if body.count(cover) != 1: fail(n, f"P2 cover appears {body.count(cover)} times in the body")
        new = re.sub(r'^!\[[^\]\n]*\]\(' + re.escape(cover) + r'\)\n', '', body, flags=re.M)
        ph = re.compile(r'^## [^\n]*[Pp]hoto(?!graphy)[^\n]*$', re.M)
        if not re.search(r'^## ' + re.escape(eh) + '$', body, re.M): fail(n, 'P5 photo heading differs from the email')
        restored = not ph.search(old)
        new = ph.sub('', new, 1) if restored else ph.sub('##PHOTO', new, 1)
        old = old if restored else ph.sub('##PHOTO', old, 1)
        norm = lambda t: re.sub(r'\n{2,}', '\n', t).strip()
        if norm(new) != norm(old): fail(n, 'P1 text changed beyond the photo lines')
    (sa, ga), (sb, gb) = fetch(rows[n]['email_img']), fetch(cover)
    d = sum(abs(x - y) for x, y in zip(ga, gb)) / 256
    if d > 2 or sa != sb: fail(n, f'P3 cover differs from the email photo: diff {d:.1f} {sa} {sb}')
    toks = sec['text']; k = toks.index('IMG')
    pre, post = W(A.md_to_text(' '.join(toks[:k]))), W(A.md_to_text(' '.join(toks[k + 1:])))
    near = lambda a, b: len(a) == len(b) and sum(x == y for x, y in zip(a, b)) >= len(a) - 1
    if n >= 53:
        # h5 era: the archive's convention (the 70+ sections that never lost their photo) is photo first
        if pre: fail(n, f'P4 text before the photo, against the WT53-130 convention: {pre[:8]}')
    else:
        if before and not near(pre[-len(before):], before): fail(n, f'P4 text before the photo: {pre[-8:]} vs email {before[-8:]}')
        if not before and pre: fail(n, f'P4 text before a photo the email puts first: {pre[:8]}')
        if not near(after[:5], post[:5]): fail(n, f'P4 text after the photo: {post[:5]} vs email {after[:5]}')
print('checked', len(targets), 'issues;', len(changed), 'changed;', 'exceptions', sorted(EXCEPT))
for f in fails: print('FAIL', *f)
sys.exit(1 if fails else 0)
