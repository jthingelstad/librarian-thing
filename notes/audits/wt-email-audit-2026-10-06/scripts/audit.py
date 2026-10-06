"""Compare sent Weekly Thing emails against librarian-thing/data/issues/<N>/archive.md.

Read-only. Writes /tmp/wtq/audit/results.json.
Run with the librarian-thing venv python (needs bs4).
"""
import json, email, re, unicodedata, collections, html as htmlmod, os, sys
from email import policy
from bs4 import BeautifulSoup, NavigableString, Comment
from urllib.parse import urlparse

ISS = '/Users/otto/Projects/thingelstad.com/librarian-thing/data/issues/'
inv = json.load(open('/tmp/wtq/audit/inventory.json'))

# ---------------- normalisation ----------------
QUOTES = {'‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ', '…': '...'}

def norm(s):
    s = unicodedata.normalize('NFKC', htmlmod.unescape(s))
    s = re.sub('[\u00ad\u200b\u200c\u200d\ufe0f\u2060]', '', s)
    for a, b in QUOTES.items():
        s = s.replace(a, b)
    s = s.lower()
    s = re.sub(r"[^\w\s]", ' ', s)          # drop punctuation (keeps unicode letters/digits)
    s = s.replace('_', ' ')
    return ' '.join(s.split())

def words(s):
    return norm(s).split()

def trigrams(ws):
    return {tuple(ws[i:i + 3]) for i in range(len(ws) - 2)}

# ---------------- email side ----------------
BLOCK = {'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'div', 'td', 'tr', 'table', 'br', 'ul', 'ol', 'pre', 'figcaption', 'figure', 'hr', 'section', 'article', 'center', 'th', 'dd', 'dt'}

TRACK_IMG = re.compile(r'cdn-images\.mailchimp\.com|gallery\.mailchimp\.com/089443193dd93823f3fed78b4|weekly\.thingelstad\.com/images/logo|static\.tinyletter\.com|tinyletterapp\.com/.*/open\.gif|list-manage\.com/track|buttondown-00\d\d\.com/o|tinylytics\.app/pixel|pstmrk\.it/open|email\.thingelstad\.com/o/|/open\.php|spacer|twemoji|emoji', re.I)

BOILER_PAT = re.compile(r"|".join([
    r'view (this email )?in (your )?browser', r'unsubscribe', r'you received this email', r'you(\'|’)re getting this email',
    r'update your preferences', r'forward to a friend', r'copyright ©', r'our mailing address', r'add us to your address book',
    r'powered by (mailchimp|tinyletter|buttondown)', r'why did i get this', r'want to change how you receive', r'this email was sent to',
    r'^weekly newsletter from jamie thingelstad$', r'all content in the weekly thing is placed here', r'change your email address',
    r'brought to you by', r'reply to this email', r'sent with buttondown', r'manage your subscription', r'^share$', r'^tweet$', r'^forward$',
]), re.I)


def email_html(path):
    m = email.message_from_binary_file(open(path, 'rb'), policy=policy.default)
    return m.get_body(preferencelist=('html',)).get_content()


def email_extract(path):
    h = email_html(path)
    soup = BeautifulSoup(h, 'html.parser')
    for t in soup(['style', 'script', 'head', 'title']):
        t.decompose()
    for c in soup.find_all(string=lambda x: isinstance(x, Comment)):
        c.extract()
    # hidden preheader spans
    for t in soup.find_all(style=re.compile(r'display:\s*none', re.I)):
        t.decompose()
    # linear text with block separators
    out = []
    def walk(node):
        for ch in node.children:
            if isinstance(ch, NavigableString):
                out.append(str(ch))
            elif ch.name:
                if ch.name in BLOCK:
                    out.append('\n')
                walk(ch)
                if ch.name in BLOCK:
                    out.append('\n')
    walk(soup)
    text = ''.join(out)
    lines = [' '.join(l.split()) for l in text.split('\n')]
    lines = [l for l in lines if l]
    anchors = []
    for a in soup.find_all('a'):
        t = ' '.join(a.get_text(' ').split())
        href = a.get('href') or ''
        if t and '/subscribers/' not in href and 'poap' not in href.lower() and 'claim' not in href.lower():
            anchors.append(t)
    heads = []
    for hx in soup.find_all(['h1', 'h2', 'h3']):
        t = ' '.join(hx.get_text(' ').split())
        if t:
            heads.append((hx.name, t))
    imgs = []
    for i in soup.find_all('img'):
        src = i.get('src', '') or ''
        w = (i.get('width') or '').replace('px', '')
        if TRACK_IMG.search(src):
            continue
        if w.isdigit() and int(w) <= 2:
            continue
        imgs.append({'src': src, 'alt': i.get('alt') or '', 'logo': '/assets/logos/' in src})
    bqs = []
    for b in soup.find_all('blockquote'):
        if b.find_parent('blockquote'):
            continue
        t = ' '.join(b.get_text(' ').split())
        if t:
            bqs.append(t)
    return {'lines': lines, 'anchors': anchors, 'heads': heads, 'imgs': imgs, 'bqs': bqs}

# ---------------- archive side ----------------

def archive_body(n):
    s = open(f'{ISS}{n}/archive.md').read()
    m = re.match(r'^---\n.*?\n---\n', s, re.S)
    return s[m.end():] if m else s


MD_IMG = re.compile(r'!\[([^\]]*)\]\(([^)\s]+)[^)]*\)')
HTML_IMG = re.compile(r'<img\b[^>]*src=["\']([^"\']+)', re.I)
MD_LINK = re.compile(r'(?<!!)\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]*)[^)]*\)')


def md_to_text(md):
    t = MD_IMG.sub(lambda m: ' ' + m.group(1) + ' ', md)
    t = re.sub(r'<img\b[^>]*>', ' ', t)
    for _ in range(2):
        t = MD_LINK.sub(lambda m: m.group(1), t)
    t = re.sub(r'</?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?/?>', ' ', t)
    t = re.sub(r'(?m)^\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s+', '', t)
    t = re.sub(r'[*_`~]', ' ', t)
    return t


def archive_extract(n):
    md = archive_body(n)
    links = [m.group(1) for m in MD_LINK.finditer(md)]
    links += re.findall(r'<a\b[^>]*>(.*?)</a>', md, re.S | re.I)
    heads = re.findall(r'(?m)^(#{1,3})\s+(.*)$', md)
    imgs = [m.group(2) for m in MD_IMG.finditer(md)] + HTML_IMG.findall(md)
    # blockquote blocks
    bq_blocks = 0
    inq = False
    for line in md.split('\n'):
        q = bool(re.match(r'\s{0,3}>', line))
        if q and not inq:
            bq_blocks += 1
        inq = q
    # collapsed lines
    collapsed = []
    for i, line in enumerate(md.split('\n')):
        mid_heads = len(re.findall(r'\S\s+#{2,3}\s', line))
        mid_quotes = len(re.findall(r'[.!?"\)]\s+>\s', line))
        if len(line) > 2500 or mid_heads >= 1 or mid_quotes >= 2:
            collapsed.append({'line': i + 1, 'len': len(line), 'mid_heads': mid_heads, 'mid_quotes': mid_quotes, 'start': line[:160]})
    text = md_to_text(md)
    return {'md': md, 'text': text, 'links': links, 'heads': heads, 'imgs': imgs, 'bq_blocks': bq_blocks, 'collapsed': collapsed}

# ---------------- sentence handling ----------------
SENT_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"“‘\'(\[])')

def sentences(lines):
    for li, l in enumerate(lines):
        for s in SENT_SPLIT.split(l):
            yield li, s

# ---------------- run ----------------
EMAIL_ONLY = re.compile(r"|".join([
    r'supporting member', r'\bpoap\b', r'claim (link|code)', r'unique claim', r'mint or reserve', r'— chatgpt', r'chatgpt$',
    r'^weekly thing \d+ with .* (links|journal entries)', r'^sent from minneapolis', r'^share weekly thing', r'/subscribers/',
    r'forward (this|it|them)', r'email a friend', r'if you(\'|’)re new here', r'^hi, i(\'|’)m jamie thingelstad', r'this is the weekly thing newsletter',
    r'highlighting helpful, interesting', r'each article i share is framed', r'^weekly thing #\d+ / ', r'tracking pixels', r'privacy is preserved',
    r'subscribe to get your own copy', r'^welcome to (the|this|issue)', r'did you know that \d+', r'interesting(ly)?,? (fact|the number)? ?\d*',
    r'electronic frontier foundation|\beff\b|creative commons', r'^venmo \|', r'licensed under a', r'creative commons attribution',
    r'inviting others you know', r'continuous focus on learning', r'how likely are you', r'what is your sentiment', r'how often are you using ai',
    r'no amount — social media', r'what is your price to go social media', r'link expires', r'is just for you', r'how to claim a poap',
    r'bragging rights', r'the token is numbered', r'ethereum wallet', r'reserve the token', r'unlock other capabilities', r'require a token',
    r'proudly display it', r'special link only for you', r'everybody(\'|’)s link is unique', r'subscribe with with your email', r'meta name="lightning"',
    r'signal stays free', r'doing the same thing for signal', r'readers have already joined', r'now(\'|’)s a good time', r'worth supporting',
    r'signal is one of those good things', r'supporting membership', r'newsletter stays free', r'testing supporting memberships', r'formal announcement later',
    r'other things you can do that would be great', r'proof of attendance', r'anniversary', r'mobius|möbius', r'collaborated with gpt-4o',
    r'each year is so unique', r'previous anniversaries', r'join (the|our) (crew|community|movement|ranks)', r'let(\'|’)s (make|see|show|champion|rally)',
    r'every (single )?(cent|penny|dollar)', r'golden opportunity', r'digital (freedom|rights)', r'^jump in', r'become (a|our)', r'hero of creativity',
    r'be (a )?part of something', r'free and open internet', r'^✨ join', r'^🌟 join', r'what this community can do',
    r'^thank you for being part', r'^at some point, you decided to join me', r'sheldon', r'nifty ink', r'magritte', r'memento mori',
    r'the quill represents', r'tech hub cities', r'peeled lemon', r'the treachery of images', r'portrait from it', r'share a gift with you',
    r'brought back the hand drawn logo', r'created a couple of them for our family', r'alongside your weekly thing', r'weekly thing 300 token',
    r'past and thought it was too hard', r'claim these just using your email', r'setup wallet software', r'multiple tokens that i',
    r'note that this link', r'this will expire in two weeks', r'with just an email address',
    r'^this was issue #\d+ of weekly thing', r'welcome to the ever-growing crew', r'^weekly thing \d+ / ', r'/archive/\d+/?$',
    r'read this issue online', r'listen to it$', r'watch the video', r'know someone who', r'^hello jamie', r'^website linkedin twitter',
    r'so far we have raised', r'we(\'|’)ve raised', r'join the fun', r'now is a great time to start', r'your new year resolution for 2026 is',
    r'^(strong )?(buy|sell|hold)$', r'^(definitely|probably|defintiely) (yes|no)$', r'^todo: fill in', r'^recommend it to strangers$',
    r'^(send them an email|email them|encourage them to sign up|with your email address)$', r'claim it, just for you', r'^kiva$',
]), re.I)

ARCH_TOP = ('micro.thingelstad.com', 'cdn.uploads.micro.blog', 'www.thingelstad.com/uploads', 'files.thingelstad.com', 'gallery.mailchimp.com',
            'gallery.tinyletterapp.com', 'buttondown', 'amazonaws')


def img_kind(src):
    if '/assets/logos/' in src:
        return 'logo'
    if 'mzstatic.com' in src or 'images-amazon.com' in src or 'imgur.com' in src:
        return 'icon/cover'
    return 'photo'


def main():
    emails = [e for e in inv['emails'] if e['issue']]
    per = {}
    for e in emails:
        if e['issue'] not in per or per[e['issue']]['dup']:
            per[e['issue']] = e
    ext = {k: email_extract(v['file']) for k, v in per.items()}
    dupinfo = {}
    for e in emails:
        if e['dup']:
            a = ext[e['issue']]['lines']
            b = email_extract(e['file'])['lines']
            diff = [l for l in b if l not in a] + [l for l in a if l not in b]
            dupinfo[e['issue']] = {'same_text': a == b, 'lines_a': len(a), 'lines_b': len(b), 'diff_sample': diff[:4]}
    df = collections.Counter()
    adf = collections.Counter()
    for k, x in ext.items():
        df.update({norm(s) for _, s in sentences(x['lines'])})
        adf.update({norm(a) for a in x['anchors']})
    results = {}
    for k in sorted(per, key=lambda x: (float(x.split('-')[0]), x)):
        x = ext[k]
        a = archive_extract(k)
        md = a['md']
        atext_n = ' ' + norm(a['text']) + ' '
        a_tri = trigrams(atext_n.split())
        alinks_n = [norm(l) for l in a['links']]
        alinks_set = set(alinks_n)
        etext_raw = '\n'.join(x['lines'])
        # ---- sentences
        missing, altered, email_only = [], [], []
        for li, s in sentences(x['lines']):
            ns = norm(s)
            ws = ns.split()
            if len(ws) < 6:
                continue
            if BOILER_PAT.search(s) or df[ns] >= 4:
                continue
            if ' ' + ns + ' ' in atext_n:
                continue
            tg = trigrams(ws)
            cov = len(tg & a_tri) / max(1, len(tg))
            if cov >= 0.8:
                continue
            rec = {'line': li, 'cov': round(cov, 2), 'words': len(ws), 'text': s[:400]}
            if EMAIL_ONLY.search(s) and cov < 0.4:
                email_only.append(rec)
            elif cov < 0.4:
                missing.append(rec)
            else:
                altered.append(rec)
        # group missing into runs of consecutive email lines
        runs = []
        for m in missing:
            if runs and m['line'] - runs[-1][-1]['line'] <= 1:
                runs[-1].append(m)
            else:
                runs.append([m])
        # ---- anchors
        a_exact, a_drift, a_unlinked, a_missing = 0, [], [], []
        seen = set()
        for t in x['anchors']:
            nt = norm(t)
            if len(nt) < 3 or nt in seen:
                continue
            seen.add(nt)
            if BOILER_PAT.search(t) or adf[nt] >= 4 or EMAIL_ONLY.search(t):
                continue
            if re.fullmatch(r'[\w.-]+\.[a-z]{2,}(/\S*)?', t.strip()) or re.fullmatch(r'https?://\S+', t.strip()):
                continue  # bare domain/url anchors (MailChimp source labels, raw urls)
            if nt in alinks_set:
                a_exact += 1
                continue
            longer = [l for l in alinks_n if nt in l and l != nt]
            shorter = [l for l in alinks_n if len(l) >= 3 and l in nt and l != nt]
            if longer or shorter:
                a_drift.append({'email': t, 'archive': (longer or shorter)[0]})
            elif ' ' + nt + ' ' in atext_n:
                a_unlinked.append(t)
            else:
                a_missing.append(t)
        # ---- headings
        h_missing = []
        for lvl, t in x['heads']:
            nt = norm(t)
            if not nt or BOILER_PAT.search(t) or df[nt] >= 4 or EMAIL_ONLY.search(t):
                continue
            if ' ' + nt + ' ' not in atext_n:
                h_missing.append(f'{lvl}: {t}')
        # ---- images
        kinds = collections.Counter(img_kind(i['src']) for i in x['imgs'])
        a_kinds = collections.Counter(img_kind(u) for u in a['imgs'])
        a_bases = {os.path.basename(urlparse(u).path).lower() for u in a['imgs']}
        img_missing_by_name = []
        for i in x['imgs']:
            if img_kind(i['src']) != 'photo':
                continue
            b = os.path.basename(urlparse(i['src']).path).lower()
            host = urlparse(i['src']).netloc
            if any(h in host for h in ('gallery.mailchimp.com', 'tinyletterapp', 'buttondown', 'amazonaws')):
                continue
            if b and b not in a_bases:
                img_missing_by_name.append(i['src'])
        # ---- blockquotes
        md_lines = md.split('\n')
        bq_demoted, bq_missing, bq_ok = [], [], 0
        for b in x['bqs']:
            nb = norm(b)
            if len(nb.split()) < 4:
                continue
            probe = ' '.join(nb.split()[:8])
            hit = None
            for line in md_lines:
                if probe in norm(md_to_text(line)):
                    hit = line
                    break
            if hit is None:
                bq_missing.append(b[:200])
            elif re.match(r'\s{0,3}>', hit) or re.match(r'\s*<blockquote', hit):
                bq_ok += 1
            else:
                bq_demoted.append(b[:200])
        # ---- bare url residue lines
        bare_urls = [l for l in md_lines if re.fullmatch(r'\s*https?://\S+\s*', l)]
        # ---- glued quote lines (and whether email had the literal "> " too)
        glued = []
        for l in md_lines:
            if re.match(r'^[^>]', l) and re.search(r' > [A-Z“"]', l) and '`' not in l:
                frag = norm(l.split(' > ', 1)[1])[:60]
                glued.append({'line': l[:200], 'in_email_literally': ('> ' in etext_raw and frag[:30] in norm(etext_raw))})
        results[k] = {
            'file': os.path.basename(per[k]['file']),
            'email_lines': len(x['lines']),
            'missing_sentences': missing,
            'missing_runs': [[m['text'][:300] for m in r] for r in runs],
            'altered_sentences': altered,
            'email_only_sentences': email_only,
            'anchors_total': len(seen),
            'anchors_exact': a_exact,
            'anchors_drift': a_drift,
            'anchors_unlinked': a_unlinked,
            'anchors_missing': a_missing,
            'heads_missing': h_missing,
            'email_imgs': dict(kinds),
            'archive_imgs': dict(a_kinds),
            'img_missing_by_name': img_missing_by_name,
            'email_bq': len(x['bqs']),
            'archive_bq': a['bq_blocks'],
            'bq_ok': bq_ok,
            'bq_demoted': bq_demoted,
            'bq_missing': bq_missing,
            'bare_url_lines': bare_urls,
            'glued_quotes': glued,
            'collapsed': a['collapsed'],
            'archive_len': len(md),
        }
    json.dump({'results': results, 'dups': dupinfo}, open('/tmp/wtq/audit/results.json', 'w'), indent=1, ensure_ascii=False)
    print('done', len(results))


if __name__ == '__main__':
    main()
