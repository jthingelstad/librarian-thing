# every WT23-130 email photo vs the archive's cover and photo-section image
from common import *
import io, os, urllib.request, concurrent.futures as cf
from PIL import Image, ImageOps
rows = json.load(open('photos.json'))
def get(u):
    p = 'img/' + re.sub(r'[^\w.]+', '_', u)[-120:]
    if os.path.exists(p): return open(p, 'rb').read()
    try:
        b = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read()
    except Exception as e: return str(e)
    open(p, 'wb').write(b); return b
def sig(b):
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(b)))
    return im.size, list(im.convert('L').resize((16, 16)).getdata())
def diff(a, b):
    if isinstance(a, str) or isinstance(b, str): return None
    (sa, ga), (sb, gb) = sig(a), sig(b)
    return round(sum(abs(x - y) for x, y in zip(ga, gb)) / 256, 1), sa, sb
def one(r):
    n = r['n']; front, body = read(n)
    cover = (re.search(r'^image: *(.*)$', front, re.M).group(1).strip().strip("'\""))
    sec = re.search(r'^## [^\n]*[Pp]hoto[^\n]*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    imgs = re.findall(r'!\[[^\]]*\]\(([^)\s]+)', sec.group(1)) + re.findall(r'<img[^>]*src="([^"]+)"', sec.group(1)) if sec else []
    e = get(r['email_img']) if r['email_img'] else None
    out = {'n': n, 'cover': cover, 'section_imgs': imgs, 'email': r['email_img']}
    if e is not None:
        out['email_ok'] = not isinstance(e, str)
        out['cover_diff'] = diff(e, get(cover)) if cover.startswith('http') else None
        out['section_diff'] = [diff(e, get(u)) for u in imgs]
    return out
with cf.ThreadPoolExecutor(8) as ex: res = list(ex.map(one, rows))
json.dump(res, open('sweep.json', 'w'), indent=1)
for o in res:
    if not o['email']:
        print(o['n'], 'no email photo; cover', o['cover'][:70], 'section imgs', len(o['section_imgs'])); continue
    cd = o.get('cover_diff'); sd = o.get('section_diff')
    bad = (not o['email_ok']) or cd is None or cd[0] > 2 or any(d is None or d[0] > 2 for d in sd) or len(o['section_imgs']) > 1
    if bad: print(o['n'], 'email_ok', o['email_ok'], 'cover', cd, o['cover'][:60], 'section', sd)
print('checked', len(res))
