from common import *
rows = []
for n in range(23, 131):
    s = soup_of(n)
    head = None
    for h in s.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
        if re.search(r'photo', h.get_text(), re.I): head = h; break
    img = None
    if head:
        for el in head.find_all_next(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img']):
            if el.name != 'img': break
            if re.search(r'gallery\.mailchimp|mcusercontent|files\.thingelstad', el.get('src', '')): img = el; break
    _, body = read(n)
    sec = re.search(r'^## [^\n]*[Pp]hoto[^\n]*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    has = bool(sec and re.search(r'!\[|<img', sec.group(1)))
    rows.append({'n': n, 'email_head': head.get_text(' ', strip=True) if head else None,
                 'email_img': img.get('src') if img else None, 'email_alt': (img.get('alt') or '') if img else None,
                 'archive_section': bool(sec), 'archive_has_img': has})
json.dump(rows, open('photos.json', 'w'), indent=1)
need = [r for r in rows if r['email_img'] and not r['archive_has_img']]
print(len(need), 'need a photo:', [r['n'] for r in need])
print('no archive section:', [r['n'] for r in need if not r['archive_section']])
print('email photo hosts:', sorted({re.sub(r'^https?://([^/]+)/.*', r'\1', r['email_img']) for r in need}))
