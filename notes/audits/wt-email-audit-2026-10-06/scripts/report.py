"""Assemble /tmp/wtq/email-audit.md from the audit JSON files."""
import json, collections

R = json.load(open('/tmp/wtq/audit/results.json'))['results']
DUPS = json.load(open('/tmp/wtq/audit/results.json'))['dups']
I = json.load(open('/tmp/wtq/audit/imgs.json'))
E = json.load(open('/tmp/wtq/audit/emph.json'))
Q = json.load(open('/tmp/wtq/audit/italq.json'))
INV = json.load(open('/tmp/wtq/audit/inventory.json'))

# Hand-verified one-offs (checked by eye against email + archive.md)
VERIFIED = {
    '22': ['8 quotes are a bare `>` line followed by the quote as a plain paragraph, so they render unquoted (email had real `<blockquote>`s; WT1-22 repair did not touch these). e.g. "Stoicism is more a meditative practice..." (line ~229)'],
    '31': ['Words dropped around links: email "💬 New Driving Change episode with Don Smithmier of Go Kart Labs." -> archive "New [Don Smithmier](..) of [Go Kart Labs](..)."'],
    '41': ['Words dropped before a link: email "Notable that Tim Berners-Lee is involved." -> archive "[Tim Berners-Lee](..) is involved."'],
    '44': ['Link-list title duplicated: "What it’s like to be a [What it\'s like to be a developer at … – Increment: Development](..)"'],
    '45': ['Link-list title duplicated: "Toys R Us to close all 800 of its [Toys R Us to close all 800 of its U.S. stores - The Washington Post](..)"'],
    '48': ['All 31 micropost photos and the weekly photo missing from body; Promotion/App logos replaced by bare URL lines; titles split ("Halide, Darkroom and Rekindling Photography as [a Hobby - the candler blog](..)"); inline anchors swallow words ("I really want to like Stallman" is all link text; email linked only "Stallman")'],
    '56': ['Micropost "Day @ time" headers replaced by bare permalink URLs (9 lines); 9 micropost photos missing'],
    '58': ['Micropost headers replaced by bare permalink URLs (8 lines); 4 micropost photos missing'],
    '63': ['Words dropped inside a sentence: email "Wow, Guido von Rossum, creator of Python, is stepping aside as Benevolent Dictator for Life!" -> archive "[Guido van Rossum](..) , creator of Python, is stepping [Benevolent Dictator for Life](..) !" ("Wow," and "aside as" lost)'],
    '65': ['5 micropost photos dropped (Tue 7:50 PM, Tue 7:46 PM, Mon 10:08 PM, Mon 8:36 PM, Mon 7:26 PM); two posts share one wrong permalink (2018/07/31/194646.html); all 5 email blockquotes are plain paragraphs'],
    '66': ['Two microposts merged and "🐖 Thanks" lost: "Enjoying a delicious lunch at Dinosaur Bar-B-Que [Jason Greenberg](..) @SPSJasonG for the recommendation!"'],
    '69': ['Link-list title garbled: "[Exclusive: This is ‘iPhone XS’ — design, larger version, iPhone XS\' — design, larger version, and gold colors confirmed | 9to5Mac]"'],
    '70': ['Four micropost image URLs pasted as one plain-text line (line ~209) above the same images'],
    '74': ['Link-list title duplicated and "the morning paper" lost: "[The design and implementation of modern column-oriented The design and implementation of modern column-oriented database systems]"; one plaintext "text (url)" link'],
    '94': ['"at Windmere Castle" dropped: email "Quest for the Amulet at Windmere Castle" -> archive "Quest for the Amulet"'],
    '97': ['Link-list title duplicated: "Tesla launches new Supercharger with 1,000 mph charging, [Tesla launches new Supercharger ... - Electrek](..)"; weekly photo missing from body'],
    '106': ['20 inline links left as plaintext "text (https://...)"; emphasis Jamie calls out is gone ("**and culture pours out.**" -> plain, next paragraph says "The emphasis is mine there."); 9 blockquotes flattened'],
    '109': ['Weekly photo missing from body (cover only in front matter)'],
    '120': ['Link-list title duplicated with a different wording: "Bike crash left Spokane man unconscious, so his Apple Watch [Bike crash left Spokane man unconscious, but his Apple Watch called 911 — The Seattle Times](..)"; "Where to find the hours" retitled "How to find the hours"'],
}
GLUED_SOURCE = {'18', '19', '26', '31', '33'}

rows = []
for k, v in R.items():
    n = float(k.split('-')[0])
    era = 'TinyLetter' if n <= 22 else 'MailChimp' if n <= 130 else 'Buttondown' if n <= 347 else 'WT Builder'
    g = I.get(k, {}).get('g', {})
    hero_lost = 1 if (23 <= n <= 130 and g.get('hero/weekly', 0) and I[k]['hero_a'] == 0) else 0
    micro_lost = (g.get('micro', 0) - g.get('micro_kept', 0)) if 23 <= n <= 130 else 0
    logos = (g.get('logo', 0) + g.get('icon/cover', 0)) if 23 <= n <= 130 else 0
    quotes = len(v['bq_demoted']) + (len(Q[k]['italic_quotes_plain']) if 23 <= n <= 37 else 0)
    if n > 130:
        quotes = 0  # checked by eye: WT166 probe hit the link heading; the real `>` quote is present
    emph = E[k]['lost'] if 23 <= n <= 130 else 0
    drift = len(v['anchors_drift']) if n <= 130 else 0
    unl = len(v['anchors_unlinked']) if n <= 130 else 0
    bare = len(v['bare_url_lines']) if n <= 130 else 0  # >130: YouTube embeds / WT259 example URL, all faithful
    verified = VERIFIED.get(k, [])
    content = hero_lost + micro_lost + (1 if verified else 0)
    if content or quotes or drift >= 10 or unl >= 5:
        tri = 'damaged'
    elif emph or drift or unl or logos or bare or k in GLUED_SOURCE:
        tri = 'minor'
    else:
        tri = 'clean'
    # severity: content-loss damage vs formatting-only damage
    sev = ''
    if tri == 'damaged':
        sev = 'content' if (hero_lost or micro_lost or (verified and k != '22') or unl >= 5) else 'format'
    rows.append(dict(k=k, n=n, era=era, tri=tri, sev=sev, quotes=quotes, emph=emph, drift=drift, unl=unl,
                     hero=hero_lost, micro=micro_lost, logos=logos, bare=bare, glued=len(v['glued_quotes']),
                     anchors=v['anchors_total'], verified=verified))
rows.sort(key=lambda r: (r['n'], r['k']))

cnt = collections.Counter(r['tri'] for r in rows)
sevc = collections.Counter(r['sev'] for r in rows if r['tri'] == 'damaged')
byera = collections.defaultdict(collections.Counter)
for r in rows:
    byera[r['era']][r['tri']] += 1

def rng(keys):
    nums = sorted(int(k) for k in keys if k.isdigit())
    out, s, p = [], None, None
    for x in nums:
        if s is None: s = p = x
        elif x == p + 1: p = x
        else: out.append(f'{s}-{p}' if s != p else str(s)); s = p = x
    if s is not None: out.append(f'{s}-{p}' if s != p else str(s))
    return ', '.join(out)

T = lambda f: sum(r[f] for r in rows)
L = []
w = L.append
w('# Weekly Thing: sent emails vs archive audit')
w('')
w('Read-only audit, 2026-10-06. Sources: 356 sent `.eml` files in `/tmp/wteml/wt-export-eml/` against `librarian-thing/data/issues/<N>/archive.md`. Scripts and raw JSON in `/tmp/wtq/audit/`.')
w('')
w('## Summary')
w('')
w(f'- 350 of 353 archive issues have a sent email (3 duplicates). Triage: **{cnt["clean"]} clean, {cnt["minor"]} minor, {cnt["damaged"]} damaged** ({sevc["content"]} with lost content, {sevc["format"]} formatting/attribution only).')
w('- The damage is almost entirely one era: **WT23-WT130 (MailChimp)**. Those bodies were rebuilt from the MailChimp plain-text part, so every inline format the plain text could not carry is gone: blockquotes, bold/italic, images, and link boundaries. Every one of the 108 issues in that range is damaged.')
w('- TinyLetter WT1-22 (just repaired) are clean apart from WT22, which still has 8 unrendered quotes. Buttondown WT131-347 and WT Builder WT348-352 are clean: every non-boilerplate sentence, link, heading, photo and blockquote in the email is in the archive. The only differences are email-only blocks the archive deliberately leaves out (polls, membership and fundraising appeals, POAP claim links, ChatGPT intros, "previous issues" lists).')
w('- The known "swallowed heading" pattern (one line holding many `### `/`>` items) no longer exists anywhere in data/issues. WT13 was the last one and is fixed. The nearest thing left is 11 "glued quote" lines in WT18, 19, 26, 31 and 33, where a comment and a ` > quote` share one line. Those are faithful to the emails, which had the literal `>` too.')
w('')
w('## Inventory')
w('')
w('| Item | Count / issues |')
w('|---|---|')
w('| Email files | 356 |')
w('| Mapped to an issue | 353 files -> 350 issues |')
w('| Not issues | 3: "Oops Thing / Ignore Welcome Email", "Welcome to the Weekly Thing!", "Preview: Yearly Thing 2025" |')
w('| Issues with no email | **WT3, WT4, WT5** (May 27, Jun 3, Jun 10 2017) |')
w('| Duplicate copies | WT8, WT9, WT13 (" 2.eml"): identical apart from the recipient address (one went to an old work address) |')
w('| Special mappings | "Weekly Thing #2^8" = WT256 (subject is 2^8); "Special Thing #140" = `140-special`; "Weekly Thing for January 6, 2018" = WT35 (archive dated Jan 7 UTC) |')
w('| Eras (by Message-ID / template) | TinyLetter WT1-22; MailChimp WT23-130; Buttondown WT131-347; WT Builder WT348-352 |')
w('')
w('Triage by era:')
w('')
w('| Era | clean | minor | damaged |')
w('|---|---|---|---|')
for era in ['TinyLetter', 'MailChimp', 'Buttondown', 'WT Builder']:
    c = byera[era]
    w(f'| {era} | {c["clean"]} | {c["minor"]} | {c["damaged"]} |')
w('')
w('## Method, and how noisy it is')
w('')
w('- **Parsing:** Python `email` with `policy.default`, `get_body(("html",))`, BeautifulSoup. Visible text is split at block tags, then into sentences. Archive bodies are the Markdown after the front matter with link/image/heading/emphasis syntax stripped. Both sides are normalised (NFKC, curly quotes, soft hyphens and zero-width characters removed, punctuation dropped, lower case).')
w('- **Sentences:** an email sentence of 6 or more words counts as present if it appears in the archive text verbatim, or if 80% or more of its word trigrams do. Sentences that recur in 4 or more emails count as template text. A short "email-only" pattern list covers Buttondown membership and fundraising appeals, polls, POAP claims, ChatGPT intros, "This was issue #N", share lines and the like. After filtering, the only content-loss hits outside WT23-130 were email-only blocks or deliberate editorial fixes (WT228 "Should" -> "Soul", WT322 "mountain goat" -> "big horn sheep", WT108 "UEFA Championship" -> "Champions League"). A second pass checked short lines (2-7 words).')
w('- **Links:** anchor text, not href. Each anchor is classified as exact (equals an archive link text), drift (archive link text contains it or is contained by it), unlinked (text present but not linked), or missing. Bare-domain anchors (the MailChimp "pxlnv.com" source labels) and personalised `/subscribers/` hrefs (polls, archive links) are skipped.')
w('- **Quotes:** each email `<blockquote>` is located in the archive by its first 8 words, then checked for whether that line starts with `>`. For WT23-37, where quotes were italic, `<em>` passages of 8 or more words that are not photo date lines are checked the same way.')
w('- **Images:** tracking pixels, template logos, MailChimp/TinyLetter/Buttondown chrome, and anything 2px or narrower are dropped. Content images are split into weekly photo, micropost photos (matched by file name across the micro.thingelstad.com / cdn.uploads.micro.blog rehost) and Give Back logos / App Store icons.')
w('- **Known false positives, all checked by eye and excluded:** blockquotes that hold lists (the probe text spans several archive lines; about 60 Buttondown-era hits); `<10MB`-style text my tag stripper first ate (WT341, fixed); bare YouTube URLs and `<video>` tags standing in for email thumbnails (WT291/305/309/312/352, equivalent); WT259 bare `abcdefg.com` line (an example URL in the text); WT166, where the quote probe hit the link title before the real `>` quote; intros the archive drops on purpose; editorial typo fixes. Drift counts are right in kind but include some legitimate cases where the archive linked a slightly longer phrase. Treat the counts as magnitudes. The examples below were all checked by hand.')
w('')
w('## Patterns (what matters most)')
w('')
w(f'1. **Quoted text flattened into Jamie\'s voice. WT22-130, {T("quotes")} quotes.** The archive for WT23-130 has *zero* `>` lines and zero emphasis markup (checked: every one of those 108 files). In the email, 38-130 used real `<blockquote>`s and 23-37 used italics, the same convention WT1-22 used before the 10-05 repair. So every excerpt reads as Jamie\'s own words, which matters to Thingy\'s `voice: "jamie"` filter and to the audio edition. Example, WT65: "So, with an internet connection faster than I could have thought possible in the late 1990s..." is a Pixel Envy quote but sits as a plain paragraph. WT22 has 8 more: a bare `>` line, then the quote unquoted.')
w(f'2. **Weekly photo and micropost photos missing from the body. {T("hero")} weekly photos (WT23-52, plus WT97 and WT109) and {T("micro")} micropost photos across {sum(1 for r in rows if r["micro"])} issues.** WT42-52 lost every Status/Microposts photo (WT44 and WT48: 31 each). WT53-130 lost some (WT54: 19 of 24, WT91: 26 of 35, WT95: 9 of 10, WT126: 12 of 30). The weekly photo survives as front-matter `image:` (cover.jpg), but the body\'s "Photo" section has only the caption. Earlier one-shots (`restore_weekly_photo`, `restore_mailchimp_images`) covered WT53+ only partly and WT23-52 not at all.')
w(f'3. **Link boundaries moved. {T("drift")} anchors drifted in WT23-130, {T("unl")} lost their link.** The linkifier rebuilt links from plain-text "text (url)" and guessed where the anchor started. Inline links swallow the words before them ("I really want to like Stallman" is all link text where the email linked "Stallman"; "this morning paired with Sump Coffee"). Link-list titles are split mid-title ("Halide, Darkroom and Rekindling Photography as [a Hobby - the candler blog]"). `fix_link_list_anchors.py` fixed list titles only for WT53-130, so **WT42-52 titles are still split** (WT51: 33 anchors drifted, WT48: 37). In WT23-31 the micropost texts, which were links to the posts in the email, are unlinked (190 anchors).')
w('4. **Text garbled where links were rebuilt.** About 14 verified one-offs: duplicated link-list titles (WT44, 45, 69, 74, 97, 120), words dropped next to a link (WT31, 41, 63, 66, 94), WT106\'s 20 links left as plain "text (https://...)", WT70\'s four image URLs on one line, and WT56/58 micropost headers replaced by bare permalink URLs.')
w(f'5. **Emphasis lost. {T("emph")} bold/italic spans in WT23-130.** Usually cosmetic ("5.9 million", "thank you"), but sometimes it carried meaning. WT106: "**and culture pours out.**" is followed by "The emphasis is mine there." and the archive has no emphasis.')
w(f'6. **Give Back logos and App-of-the-week icons dropped. {T("logos")} images, WT23-112.** Each was replaced by a stray bare-URL line (the link the image sat in): {T("bare")} bare-URL lines in WT23-130, e.g. "https://www.eff.org" above the EFF blurb. Cosmetic, but the URL lines read as junk.')
w('7. **Source-side glitches, not archive damage:** WT18, 19, 26, 31 and 33 have "comment > quote" glued on one line because the email did too; WT37\'s email shipped with "ToDo: Fill in with welcome."; WT82\'s email had a broken `‘Machine Learning University](https://aws.training/...)`. The archive cleaned up both. The glued quotes would need a judgement call.')
w('8. **Buttondown/WT Builder: nothing lost.** Email-only blocks are absent by design: fundraising appeals in WT299-349, polls in WT258/297-302/323/338, POAP claims in WT200/219/254/288/300/319, ChatGPT number-fact intros in WT263-271, and "previous issues" lists. The one grey area is WT288 and WT319: the anniversary-art paragraphs (Daniel Sheldon\'s piece and its description; the Escher-inspired token image) sat in the POAP block and are not in the archive. If Jamie considers the art itself content, those two paragraphs and images could be restored.')
w('')
w('## Damaged issues with examples')
w('')
w('Issues WT23-130 all share patterns 1, 3 and 5 (quotes flattened, anchors drifted, emphasis lost). The list below gives what is specific to each one beyond that.')
w('')
for r in rows:
    if r['tri'] != 'damaged':
        continue
    bits = []
    if r['quotes']: bits.append(f'{r["quotes"]} quotes flattened')
    if r['hero']: bits.append('weekly photo missing from body')
    if r['micro']: bits.append(f'{r["micro"]} micropost photos missing')
    if r['drift']: bits.append(f'{r["drift"]} anchors drifted')
    if r['unl']: bits.append(f'{r["unl"]} anchors unlinked')
    if r['emph']: bits.append(f'{r["emph"]} emphasis spans lost')
    if r['logos']: bits.append(f'{r["logos"]} logo/icon images dropped')
    line = f'- **WT{r["k"]}** ({r["sev"]}): ' + '; '.join(bits)
    if r['verified']:
        line += '. ' + ' '.join(r['verified'])
    w(line)
w('')
w('Example quotes flattened (first per issue, sample):')
w('')
ex = 0
for r in rows:
    k = r['k']
    if r['quotes'] and ex < 8 and k in R and R[k]['bq_demoted']:
        w(f'- WT{k}: "{R[k]["bq_demoted"][0][:150]}..."')
        ex += 1
for k in ['24', '36']:
    w(f'- WT{k} (italic in email): "{Q[k]["italic_quotes_plain"][0][:150]}..."')
w('')
w('## Minor issues')
w('')
minor = [r for r in rows if r['tri'] == 'minor']
for r in minor:
    bits = []
    if r['glued']: bits.append(f'{r["glued"]} glued "comment > quote" line(s), present in the email too')
    if r['bare']: bits.append(f'{r["bare"]} bare-URL line(s)')
    if r['emph']: bits.append(f'{r["emph"]} emphasis lost')
    w(f'- WT{r["k"]}: ' + ('; '.join(bits) or 'small differences'))
w('')
w('## Per-issue triage table')
w('')
w('quotes = email quotes rendered as plain text; drift/unl = anchors whose link boundary moved / link lost; photos = weekly photo + micropost photos missing from body; logos = Give Back/App icons dropped; emph = bold/italic spans lost.')
w('')
w('| WT | era | triage | quotes | drift | unl | photos | logos | emph | anchors |')
w('|---|---|---|---|---|---|---|---|---|---|')
for r in rows:
    w(f'| {r["k"]} | {r["era"]} | {r["tri"]}{" ("+r["sev"]+")" if r["sev"] else ""} | {r["quotes"]} | {r["drift"]} | {r["unl"]} | {r["hero"] + r["micro"]} | {r["logos"]} | {r["emph"]} | {r["anchors"]} |')
w('| 3, 4, 5 | TinyLetter | no email | | | | | | | |')
w('')
w('## What a repair would involve')
w('')
w('The emails are a complete, faithful source for WT23-130, so the repair is mechanical. Re-derive the body from the HTML part instead of the plain text, keep the archive\'s section structure, and apply it as a reviewed diff. Rough shape:')
w('')
w('1. **Quotes (WT22-130, about 580 passages).** For each email `<blockquote>` (38-130) or long `<em>` excerpt (23-37), find the matching archive paragraph and prefix it with `> `, splitting off any trailing Jamie comment the way the WT1-22 commit did. WT22: join the 8 bare `>` lines to their following paragraph. Fully scriptable; review a sample per year. This is the highest-value fix (attribution, Thingy voice filter, audio).')
w('2. **Photos (WT23-130, 31 weekly photos and about 356 micropost photos).** Weekly photo: insert `![caption](cover.jpg URL from front matter)` under the Photo heading for WT23-52, 97 and 109; the files already exist. Micropost photos: the email gives each `micro.thingelstad.com/uploads/YYYY/<hash>.jpg`, and the same file names already resolve on `cdn.uploads.micro.blog/890/` for the kept ones. Place them under their micropost by matching the post text. Needs a HEAD check on the rehost host before writing; that is a network step, outside this audit.')
w('3. **Link boundaries (WT23-130, about 1,000 anchors).** For each email `<a>` (anchor text + resolved href; the MailChimp redirect hrefs need mapping to the archive URL by order within the paragraph), reset the bracket span in the archive line to the email anchor text. Same mechanics as `fix_link_list_anchors.py`, extended to inline links and to WT42-52 list titles. WT23-31 micropost permalinks can be re-linked from the email anchors. Moderate effort; the main risk is mis-mapping when one paragraph has several links, so gate on "exact anchor text found once in line".')
w('4. **Hand fixes (about 14 issues):** WT31, 41, 44, 45, 56, 58, 63, 66, 69, 70, 74, 94, 97, 106, 120 as listed above. WT106 needs its 20 plain-text links linkified.')
w('5. **Emphasis (132 spans) and logo lines (about 140 bare-URL lines).** Restore `**`/`_` from the email; delete or convert the bare-URL lines. Low value, easy to do in the same pass.')
w('6. Afterwards regenerate `links.json`/front-matter `links` and `word_count` (as the WT1-22 commit did), then re-run this audit (`/tmp/wtq/audit/audit.py`) to confirm WT23-130 come out clean.')
w('')
w('A practical order: (1) quotes, (2) weekly photos, (3) WT42-52 split titles and the hand-fix list, then (4) inline anchor drift and micropost photos, which need the most care. Reconstruction from HTML would be about one script plus a few hours of per-era spot review. Nothing outside WT22-130 needs repair.')
w('')
w('## Files')
w('')
w('- `/tmp/wtq/audit/inventory.py` -> `inventory.json` (email to issue mapping)')
w('- `/tmp/wtq/audit/audit.py` -> `results.json` (per-issue sentences, anchors, headings, images, quotes)')
w('- `imgs.py` -> `imgs.json`; `emph.py` -> `emph.json`; `italq.py` -> `italq.json`; `worddiff.py` -> `worddiff.json`; `shortlines.py`; `dupgram.py`')
w('- `report.py` -> this file. Run with `/Users/otto/Projects/thingelstad.com/librarian-thing/.venv/bin/python` (needs bs4).')
open('/tmp/wtq/email-audit.md', 'w').write('\n'.join(L) + '\n')
print(cnt, sevc, {e: dict(c) for e, c in byera.items()})
print('quotes', T('quotes'), 'hero', T('hero'), 'micro', T('micro'), 'drift', T('drift'), 'unl', T('unl'), 'emph', T('emph'), 'logos', T('logos'), 'bare', T('bare'))
print('minor', [r['k'] for r in rows if r['tri'] == 'minor'])
print('damaged outside 22-130', [r['k'] for r in rows if r['tri'] == 'damaged' and not (22 <= r['n'] <= 130)])
