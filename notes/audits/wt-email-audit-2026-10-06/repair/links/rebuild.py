"""Rebuild the WT23-130 lines whose links the import damaged, from the sent email.

For each archive line matched to an email block (align.py), when the block shows
link damage, the line is rewritten from the email's inline HTML: its words, link
spans and emphasis. URLs come from the archive (the WT23-55 emails hide them
behind MailChimp click tracking, so links pair by order there; from WT56 by URL).
The archive's own one-word substitutions (typo fixes such as von -> van) are kept.
A block whose words differ away from the links is left alone and reported:
that is an edit, not link damage.

    python rebuild.py [--write] [N ...]
"""
import collections, subprocess, urllib.parse, difflib, html as htmlmod, json, re, sys
from bs4 import NavigableString, Comment
sys.path.insert(0, '/tmp/wtq/r3')
from common import A, ISS, read, soup_of
from align import nurl, md_line_tokens, link_spans, INLINE, MD_LINK

EMPH = {'strong': '**', 'b': '**', 'em': '_', 'i': '_'}
WORD = re.compile(r'\S+')
PREFIX = re.compile(r'^(\s{0,3}(?:#{1,6}|>+|[-*+]|\d+\.)\s+|>\s?)*')


def email_blocks(n):
    """Segments as pieces [(text, href, emph)] between block boundaries."""
    s = soup_of(n)
    for c in s.find_all(string=lambda x: isinstance(x, Comment)): c.extract()
    blocks, cur = [], []
    def flush():
        if any(p[0].strip() and not p[0].startswith('\x00') for p in cur): blocks.append(list(cur))
        cur.clear()
    def walk(node, href, emph):
        for ch in node.children:
            if isinstance(ch, NavigableString):
                cur.append((str(ch), href, emph))
            elif ch.name:
                if ch.name == 'img':
                    if ch.get('class') and 'emoji' in ' '.join(ch.get('class')): cur.append((ch.get('alt') or '', href, emph))
                    continue
                if ch.name not in INLINE: flush()
                if ch.name == 'small':
                    cur.append(('\x00SMALL<', None, None)); walk(ch, href, emph); cur.append(('\x00SMALL>', None, None)); continue
                walk(ch, ch.get('href') if ch.name == 'a' else href, EMPH.get(ch.name, emph))
                if ch.name not in INLINE: flush()
    walk(s, None, None); flush()
    return blocks


def variants(pieces):
    """The block as written, and without its <small> labels (the domain after a link-list title)."""
    full, bare, inside = [], [], False
    for pc in pieces:
        if pc[0] == '\x00SMALL<': inside = True; continue
        if pc[0] == '\x00SMALL>': inside = False; continue
        full.append(pc)
        if not inside: bare.append(pc)
    return [full, bare] if len(bare) != len(full) else [full]


def piece_tokens(pieces):
    """Word tokens (norm, href, emph, piece index, chunk start, chunk end) over the pieces."""
    out = []
    for k, (t, href, emph) in enumerate(pieces):
        for m in WORD.finditer(t):
            for part in A.norm(m.group(0)).split():
                out.append((part, nurl(href) if href else None, emph, k, m.start(), m.end()))
    return out


def spans(seq, key):
    out, i = [], 0
    while i < len(seq):
        if seq[i][key]:
            j = i
            while j < len(seq) and seq[j][key] == seq[i][key]: j += 1
            out.append((i, j, seq[i][key])); i = j
        else: i += 1
    return out


def archive_links(line):
    """[(anchor text, url)] in order, as written."""
    return [(m.group(1), m.group(2)) for m in MD_LINK.finditer(line)]


def build(pieces, url_for, subs):
    """Markdown for an email block. url_for(k) gives the URL for the k-th link span; subs
    maps (piece, start, end) -> archive surface for kept substitutions."""
    # apply substitutions inside pieces (from the end so offsets hold)
    pieces = [list(p) for p in pieces]
    for (k, a, b), rep in sorted(subs.items(), key=lambda x: (x[0][0], -x[0][1])):
        t = pieces[k][0]; pieces[k][0] = t[:a] + rep + t[b:]
    # group consecutive pieces by href, then emphasis inside
    out, i, link_no = [], 0, 0
    def emph_md(ps):
        s, j = [], 0
        while j < len(ps):
            e = ps[j][2]; k = j
            while k < len(ps) and ps[k][2] == e: k += 1
            txt = ''.join(p[0] for p in ps[j:k])
            if e and txt.strip():
                lead = txt[:len(txt) - len(txt.lstrip())]; trail = txt[len(txt.rstrip()):]
                s.append(f'{lead}{e}{txt.strip()}{e}{trail}')
            else: s.append(txt)
            j = k
        return ''.join(s)
    while i < len(pieces):
        h = pieces[i][1]; j = i
        while j < len(pieces) and pieces[j][1] == h: j += 1
        body = emph_md(pieces[i:j])
        if h and body.strip():
            u = url_for(link_no); link_no += 1
            lead = body[:len(body) - len(body.lstrip())]; trail = body[len(body.rstrip()):]
            out.append(f'{lead}[{body.strip()}]({u}){trail}' if u else body)
        else:
            out.append(body)
        i = j
    return ' '.join(''.join(out).split())


CONTENT = {'anchor moved', 'space before punctuation', 'words at a link', 'duplicated title',
           'link title from the email', 'plain-text link', 'link restored', 'link count'}
QUOTEISH = set('"“”\'‘’,;:')

def keep_archive_form(old, new):
    """Undo the email's case, quote-mark and comma differences: the archive's form stands.
    Only small character edits outside link markup are reverted; words and links are not.
    A quote pair split by a link boundary ('[man crush'](u)) closes outside the link."""
    new = re.sub(r"""(['"‘“])\[([^\[\]]*?)(['"’”])\]\(([^)\s]*)\)""", r'\1[\2](\4)\3', new)
    new = re.sub(r"""\[(['"‘“])([^\[\]]*?)\]\(([^)\s]*)\)(['"’”])""", r'\1[\2](\3)\4', new)
    bare = lambda x: re.sub(r'\]\([^)\s]*\)|[\[\]]', '', x)
    if bare(old) != bare(new):
        # compare text only, then carry the archive's characters back where the
        # difference is form alone
        fixed = _revert_form(bare(old), bare(new))
        if fixed != bare(new):
            new = _reapply(new, fixed)
    return new

def _revert_form(old, new):
    out, sm = [], difflib.SequenceMatcher(None, old, new, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        a, b = old[i1:i2], new[j1:j2]
        if op != 'equal' and ((op == 'replace' and a.lower() == b.lower()) or (a + b and set(a + b) <= QUOTEISH)):
            out.append(a)
        else:
            out.append(b)
    return ''.join(out)

def _reapply(md, text):
    """Rewrite md so its text (md without link markup) becomes text, keeping the markup."""
    parts = re.split(r'(\]\([^)\s]*\)|[\[\]])', md)
    idx, cur, plain = [], 0, []   # md index of each plain char
    for k, p in enumerate(parts):
        if k % 2 == 0:
            idx += range(cur, cur + len(p)); plain.append(p)
        cur += len(p)
    plain = ''.join(plain); out = list(md); ins = {}
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, plain, text, autojunk=False).get_opcodes():
        if op == 'equal': continue
        for k in range(i1, i2): out[idx[k]] = ''
        at = idx[i1] if i1 < len(idx) else len(md)
        ins[at] = ins.get(at, '') + text[j1:j2]
    return ''.join(ins.get(k, '') + c for k, c in enumerate(out)) + ins.get(len(md), '')

def plan_issue(n):
    """Return (edits {line_no: new_line}, report list)."""
    front, body = read(n)
    lines = body.split('\n')
    blocks = [v for b in email_blocks(n) for v in variants(b)]
    btoks = [piece_tokens(b) for b in blocks]
    tracked = sum(1 for b in blocks for p in b if p[1] and 'list-manage.com/track' in p[1])
    index = collections.defaultdict(set)
    for k, ts in enumerate(btoks):
        w = [t[0] for t in ts]
        for i in range(len(w) - 1): index[(w[i], w[i + 1])].add(k)
    edits, report = {}, []
    # Jamie, 10-06: the nonprofit spotlights ("## Promotion 🎁") must not be restored or
    # touched up; the repair leaves those sections exactly as they are
    promo, sec = set(), None
    for ln, line in enumerate(lines):
        if line.startswith('## '): sec = line
        if sec and ('Promotion' in sec or 'Now Reading' in sec): promo.add(ln)  # and the "Now Reading" line
    for ln, line in enumerate(lines):
        if ln in promo: continue
        if not line.strip() or line.lstrip().startswith(('![', '<', '---', '|')): continue
        plain = re.findall(r'(?<!\])\((https?://[^)\s]+)\)', line)   # WT74/106: links left as "text (url)"
        at = md_line_tokens(re.sub(r'\s?(?<!\])\((https?://[^)\s]+)\)', '', line))
        if len(at) < 2: continue
        aw = [t[1] for t in at]
        cands = collections.Counter()
        for i in range(len(aw) - 1):
            for k in index.get((aw[i], aw[i + 1]), ()): cands[k] += 1
        best, br = None, 0.0
        for k, _ in cands.most_common(8):
            ew = [t[0] for t in btoks[k]]
            sm = difflib.SequenceMatcher(None, aw, ew, autojunk=False)
            m = sum(b.size for b in sm.get_matching_blocks())
            r = 2 * m / (len(aw) + len(ew))   # symmetric: the line must be the whole block
            if r > br: best, br = k, r
        if best is None or br < 0.75: continue
        et = btoks[best]; ew = [t[0] for t in et]; pieces = blocks[best]
        sm = difflib.SequenceMatcher(None, aw, ew, autojunk=False)
        ops = sm.get_opcodes()
        amap = {}
        for tag, i1, i2, j1, j2 in ops:
            if tag == 'equal':
                for d in range(i2 - i1): amap[i1 + d] = j1 + d
        a_sp = link_spans(at)                      # (i, j, url) in archive word positions
        e_sp = spans(et, 1)                        # (i, j, nurl|None) in email word positions
        bounds = {x for i, j, _ in e_sp for x in (i, j)} | {amap.get(i, -9) for i, j, _ in a_sp} | {amap.get(j - 1, -9) + 1 for i, j, _ in a_sp}
        near = lambda p: any(abs(p - b) <= 1 for b in bounds)
        subs, reasons, foreign = {}, set(), False
        def keep_archive(i1, i2, j1, j2):
            """Put the archive's words for tokens i1..i2 where the email has j1..j2."""
            asurf = []
            for i in range(i1, i2):
                if not asurf or asurf[-1] is not at[i][0]: asurf.append(at[i][0])
            rep = ' '.join(asurf)
            if j2 > j1:
                chunks = []
                for j in range(j1, j2):
                    c = (et[j][3], et[j][4], et[j][5])
                    if c not in chunks: chunks.append(c)
                # a chunk shared with an equal neighbour cannot be split cleanly: give up on the line
                if (j1 > 0 and (et[j1 - 1][3], et[j1 - 1][4]) == chunks[0][:2]) or (j2 < len(et) and (et[j2][3], et[j2][4]) == chunks[-1][:2]):
                    return False
                subs[chunks[0]] = rep
                for c in chunks[1:]: subs[c] = ''
            elif j1 < len(et):
                k, a, b = et[j1][3], et[j1][4], et[j1][5]
                if j1 > 0 and (et[j1 - 1][3], et[j1 - 1][4]) == (k, a): return False
                subs[(k, a, a)] = rep + ' '
            else:
                k, a, b = et[-1][3], et[-1][4], et[-1][5]
                subs[(k, b, b)] = ' ' + rep
            return True
        for tag, i1, i2, j1, j2 in ops:
            if tag == 'equal': continue
            a_txt, e_txt = ' '.join(aw[i1:i2]), ' '.join(ew[j1:j2])
            in_link = any(et[j][1] for j in range(j1, j2)) or any(at[i][2] for i in range(i1, i2))
            at_link = near(j1) or near(j2) or in_link
            hood = set(aw[max(0, i1 - 40):i1] + aw[i2:i2 + 40])
            nxt = next((s for s in a_sp if s[0] == i2), None)
            dup = (i2 - i1 >= 3 and sum(w in hood for w in aw[i1:i2]) >= 0.8 * (i2 - i1)) or \
                  (nxt is not None and aw[i1:i2] == aw[nxt[0]:nxt[0] + i2 - i1])   # "Johnny Cash: [Johnny Cash: ...]" 
            if a_txt and e_txt and difflib.SequenceMatcher(None, a_txt, e_txt).ratio() >= 0.6:
                if not keep_archive(i1, i2, j1, j2): foreign = True
                else: reasons.add('archive correction kept')
            elif tag == 'insert':
                if at_link: reasons.add('words at a link')
                else: foreign = True
            elif dup:
                reasons.add('duplicated title')
            elif in_link and e_txt:
                reasons.add('link title from the email')
            else:
                foreign = 'edit'   # the archive reworded Jamie's text here: keep the whole line as it is
        # pair links
        e_links = [s for s in e_sp]
        arch = archive_links(line)
        arch = [(t, u) for t, u in arch if t.strip()] + [('PLAIN', u) for u in plain]
        if plain: reasons.add('plain-text link')
        is_tracked = bool(e_links) and all(u == 'TRACKED' for *_, u in e_links)
        urls = []
        if is_tracked:
            if len(arch) == len(e_links): urls = [u for _, u in arch]
            elif len(e_links) == 1 and len(arch) == 1: urls = [arch[0][1]]
            else: report.append((n, ln, 'tracked link count differs', line[:120])); continue
        else:
            pool = list(arch)
            for i, j, u in e_links:
                hit = next((x for x in pool if nurl(x[1]) == u), None)
                if hit: pool.remove(hit); urls.append(hit[1])
                else:
                    raw = next(p[1] for p in pieces if p[1] and nurl(p[1]) == u)
                    urls.append(re.sub(r'^(https?://mailchi\.mp/[^?#]*)\?e=[0-9a-f]+$', r'\1', urllib.parse.unquote(htmlmod.unescape(raw)).strip('"\'“”‘’ '))); reasons.add('link restored')
            for t, u in pool:
                if any(abs(len(t) - 1) == 0 for _ in [0]) and t.strip() == '→': continue
                reasons.add('archive link not in email')
        # moved anchors
        for (ai, aj, au) in a_sp:
            hit = [s for s in e_sp if s[2] in (nurl(au), 'TRACKED')]
            if not any(amap.get(ai) == s[0] and amap.get(aj - 1) == s[1] - 1 for s in hit): reasons.add('anchor moved'); break
        if len(e_sp) != len([s for s in a_sp]): reasons.add('link count')
        # Jamie, 10-06: "you're not restoring the format, you're restoring the content".
        # No bold or italics from the email, no 💬 lead-ins, no "→" microposts made into
        # whole-text links; a line whose own emphasis a rebuild would lose is left alone
        # (the render check below)
        pieces = [(t, h, None) for t, h, _ in pieces]
        if '💬' not in line:
            pieces = [(re.sub(r'💬\s*', '', t), h, e) for t, h, e in pieces]
        if '[→](' in line:
            report.append((n, ln, 'micropost "→" link: format, left alone', line[:120])); continue
        if re.search(r'\]\([^)]*\) [,.!?;:)]', line): reasons.add('space before punctuation')
        if 'archive link not in email' in reasons:
            report.append((n, ln, 'archive has a link the email lacks', line[:120])); continue
        if foreign == 'edit':
            report.append((n, ln, 'archive rewording at a link: left alone', line[:120])); continue
        if foreign:
            report.append((n, ln, 'words differ away from links: left alone', line[:120])); continue
        if not reasons & CONTENT: continue
        new = build(pieces, lambda k: urls[k] if k < len(urls) else None, subs)
        prefix = PREFIX.match(line).group(0)
        new = keep_archive_form(line, prefix + new.lstrip())
        if new != line: edits[ln] = (new, sorted(reasons))
    # never drop a link: render both versions with the site's markdown-it (which also
    # linkifies bare URLs such as "www.thingelstad.com/archive/") and keep only the
    # edits that still link every URL the old line linked
    if edits:
        lines = body.split('\n'); keys = sorted(edits)
        r = json.loads(subprocess.run(['node', '/tmp/wtq/r3/inline.cjs'], capture_output=True, text=True, check=True,
                                      input=json.dumps([lines[k] for k in keys] + [edits[k][0] for k in keys])).stdout)
        hrefs = lambda x: {urllib.parse.unquote(h) for _, h in x['links']}
        for i, k in enumerate(keys):
            o, w = r[i], r[len(keys) + i]
            if hrefs(o) - hrefs(w):
                report.append((n, k, 'would drop a link: left alone', lines[k][:120])); del edits[k]
            elif (o['strong'] or o['em']) and (o['strong'], o['em']) != (w['strong'], w['em']):
                report.append((n, k, "would change the archive's own emphasis: left alone", lines[k][:120])); del edits[k]
            elif any(nw[:len(ow)] == ow and len(nw) > len(ow)
                     for u, ow in ((u, A.norm(t).split()) for t, u in o['links'])
                     for t2, u2 in w['links'] if u2 == u for nw in [A.norm(t2).split()]):
                # the email linked a title plus its description (WT66, WT91): form, not damage
                report.append((n, k, 'email links a longer span: format, left alone', lines[k][:120])); del edits[k]
    return edits, report


if __name__ == '__main__':
    write = '--write' in sys.argv
    nums = [int(a) for a in sys.argv[1:] if a.isdigit()] or list(range(23, 131))
    total = collections.Counter(); rep = []
    for n in nums:
        edits, report = plan_issue(n)
        rep += report
        for ln, (new, why) in sorted(edits.items()):
            for w in why: total[w] += 1
            total['lines'] += 1
            if not write and len(nums) <= 3:
                print(f'{n}:{ln} {why}\n  - {read(n)[1].split(chr(10))[ln][:220]}\n  + {new[:220]}')
        if write and edits:
            front, body = read(n); lines = body.split('\n')
            for ln, (new, _) in edits.items(): lines[ln] = new
            open(f'{ISS}{n}/archive.md', 'w', encoding='utf-8').write(front + '\n'.join(lines))
    print(dict(total)); print(collections.Counter(r[2] for r in rep))
    json.dump(rep, open('/tmp/wtq/r3/report.json', 'w'), ensure_ascii=False, indent=0)
