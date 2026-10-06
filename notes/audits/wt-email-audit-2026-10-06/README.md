# Weekly Thing: sent emails vs archive audit

Read-only audit, 2026-10-06. Sources: 356 sent `.eml` files in `/tmp/wteml/wt-export-eml/` against `librarian-thing/data/issues/<N>/archive.md`. Scripts and raw JSON in `/tmp/wtq/audit/`.

## Summary

- 350 of 353 archive issues have a sent email (3 duplicates). Triage: **239 clean, 2 minor, 109 damaged** (74 with lost content, 35 formatting/attribution only).
- The damage is almost entirely one era: **WT23-WT130 (MailChimp)**. Those bodies were rebuilt from the MailChimp plain-text part, so every inline format the plain text could not carry is gone: blockquotes, bold/italic, images, and link boundaries. Every one of the 108 issues in that range is damaged.
- TinyLetter WT1-22 (just repaired) are clean apart from WT22, which still has 8 unrendered quotes. Buttondown WT131-347 and WT Builder WT348-352 are clean: every non-boilerplate sentence, link, heading, photo and blockquote in the email is in the archive. The only differences are email-only blocks the archive deliberately leaves out (polls, membership and fundraising appeals, POAP claim links, ChatGPT intros, "previous issues" lists).
- The known "swallowed heading" pattern (one line holding many `### `/`>` items) no longer exists anywhere in data/issues. WT13 was the last one and is fixed. The nearest thing left is 11 "glued quote" lines in WT18, 19, 26, 31 and 33, where a comment and a ` > quote` share one line. Those are faithful to the emails, which had the literal `>` too.

## Inventory

| Item | Count / issues |
|---|---|
| Email files | 356 |
| Mapped to an issue | 353 files -> 350 issues |
| Not issues | 3: "Oops Thing / Ignore Welcome Email", "Welcome to the Weekly Thing!", "Preview: Yearly Thing 2025" |
| Issues with no email | **WT3, WT4, WT5** (May 27, Jun 3, Jun 10 2017) |
| Duplicate copies | WT8, WT9, WT13 (" 2.eml"): identical apart from the recipient address (one went to an old work address) |
| Special mappings | "Weekly Thing #2^8" = WT256 (subject is 2^8); "Special Thing #140" = `140-special`; "Weekly Thing for January 6, 2018" = WT35 (archive dated Jan 7 UTC) |
| Eras (by Message-ID / template) | TinyLetter WT1-22; MailChimp WT23-130; Buttondown WT131-347; WT Builder WT348-352 |

Triage by era:

| Era | clean | minor | damaged |
|---|---|---|---|
| TinyLetter | 16 | 2 | 1 |
| MailChimp | 0 | 0 | 108 |
| Buttondown | 218 | 0 | 0 |
| WT Builder | 5 | 0 | 0 |

## Method, and how noisy it is

- **Parsing:** Python `email` with `policy.default`, `get_body(("html",))`, BeautifulSoup. Visible text is split at block tags, then into sentences. Archive bodies are the Markdown after the front matter with link/image/heading/emphasis syntax stripped. Both sides are normalised (NFKC, curly quotes, soft hyphens and zero-width characters removed, punctuation dropped, lower case).
- **Sentences:** an email sentence of 6 or more words counts as present if it appears in the archive text verbatim, or if 80% or more of its word trigrams do. Sentences that recur in 4 or more emails count as template text. A short "email-only" pattern list covers Buttondown membership and fundraising appeals, polls, POAP claims, ChatGPT intros, "This was issue #N", share lines and the like. After filtering, the only content-loss hits outside WT23-130 were email-only blocks or deliberate editorial fixes (WT228 "Should" -> "Soul", WT322 "mountain goat" -> "big horn sheep", WT108 "UEFA Championship" -> "Champions League"). A second pass checked short lines (2-7 words).
- **Links:** anchor text, not href. Each anchor is classified as exact (equals an archive link text), drift (archive link text contains it or is contained by it), unlinked (text present but not linked), or missing. Bare-domain anchors (the MailChimp "pxlnv.com" source labels) and personalised `/subscribers/` hrefs (polls, archive links) are skipped.
- **Quotes:** each email `<blockquote>` is located in the archive by its first 8 words, then checked for whether that line starts with `>`. For WT23-37, where quotes were italic, `<em>` passages of 8 or more words that are not photo date lines are checked the same way.
- **Images:** tracking pixels, template logos, MailChimp/TinyLetter/Buttondown chrome, and anything 2px or narrower are dropped. Content images are split into weekly photo, micropost photos (matched by file name across the micro.thingelstad.com / cdn.uploads.micro.blog rehost) and Give Back logos / App Store icons.
- **Known false positives, all checked by eye and excluded:** blockquotes that hold lists (the probe text spans several archive lines; about 60 Buttondown-era hits); `<10MB`-style text my tag stripper first ate (WT341, fixed); bare YouTube URLs and `<video>` tags standing in for email thumbnails (WT291/305/309/312/352, equivalent); WT259 bare `abcdefg.com` line (an example URL in the text); WT166, where the quote probe hit the link title before the real `>` quote; intros the archive drops on purpose; editorial typo fixes. Drift counts are right in kind but include some legitimate cases where the archive linked a slightly longer phrase. Treat the counts as magnitudes. The examples below were all checked by hand.

## Patterns (what matters most)

1. **Quoted text flattened into Jamie's voice. WT22-130, 585 quotes.** The archive for WT23-130 has *zero* `>` lines and zero emphasis markup (checked: every one of those 108 files). In the email, 38-130 used real `<blockquote>`s and 23-37 used italics, the same convention WT1-22 used before the 10-05 repair. So every excerpt reads as Jamie's own words, which matters to Thingy's `voice: "jamie"` filter and to the audio edition. Example, WT65: "So, with an internet connection faster than I could have thought possible in the late 1990s..." is a Pixel Envy quote but sits as a plain paragraph. WT22 has 8 more: a bare `>` line, then the quote unquoted.
2. **Weekly photo and micropost photos missing from the body. 31 weekly photos (WT23-52, plus WT97 and WT109) and 356 micropost photos across 47 issues.** WT42-52 lost every Status/Microposts photo (WT44 and WT48: 31 each). WT53-130 lost some (WT54: 19 of 24, WT91: 26 of 35, WT95: 9 of 10, WT126: 12 of 30). The weekly photo survives as front-matter `image:` (cover.jpg), but the body's "Photo" section has only the caption. Earlier one-shots (`restore_weekly_photo`, `restore_mailchimp_images`) covered WT53+ only partly and WT23-52 not at all.
3. **Link boundaries moved. 1035 anchors drifted in WT23-130, 190 lost their link.** The linkifier rebuilt links from plain-text "text (url)" and guessed where the anchor started. Inline links swallow the words before them ("I really want to like Stallman" is all link text where the email linked "Stallman"; "this morning paired with Sump Coffee"). Link-list titles are split mid-title ("Halide, Darkroom and Rekindling Photography as [a Hobby - the candler blog]"). `fix_link_list_anchors.py` fixed list titles only for WT53-130, so **WT42-52 titles are still split** (WT51: 33 anchors drifted, WT48: 37). In WT23-31 the micropost texts, which were links to the posts in the email, are unlinked (190 anchors).
4. **Text garbled where links were rebuilt.** About 14 verified one-offs: duplicated link-list titles (WT44, 45, 69, 74, 97, 120), words dropped next to a link (WT31, 41, 63, 66, 94), WT106's 20 links left as plain "text (https://...)", WT70's four image URLs on one line, and WT56/58 micropost headers replaced by bare permalink URLs.
5. **Emphasis lost. 132 bold/italic spans in WT23-130.** Usually cosmetic ("5.9 million", "thank you"), but sometimes it carried meaning. WT106: "**and culture pours out.**" is followed by "The emphasis is mine there." and the archive has no emphasis.
6. **Give Back logos and App-of-the-week icons dropped. 130 images, WT23-112.** Each was replaced by a stray bare-URL line (the link the image sat in): 142 bare-URL lines in WT23-130, e.g. "https://www.eff.org" above the EFF blurb. Cosmetic, but the URL lines read as junk.
7. **Source-side glitches, not archive damage:** WT18, 19, 26, 31 and 33 have "comment > quote" glued on one line because the email did too; WT37's email shipped with "ToDo: Fill in with welcome."; WT82's email had a broken `‘Machine Learning University](https://aws.training/...)`. The archive cleaned up both. The glued quotes would need a judgement call.
8. **Buttondown/WT Builder: nothing lost.** Email-only blocks are absent by design: fundraising appeals in WT299-349, polls in WT258/297-302/323/338, POAP claims in WT200/219/254/288/300/319, ChatGPT number-fact intros in WT263-271, and "previous issues" lists. The one grey area is WT288 and WT319: the anniversary-art paragraphs (Daniel Sheldon's piece and its description; the Escher-inspired token image) sat in the POAP block and are not in the archive. If Jamie considers the art itself content, those two paragraphs and images could be restored.

## Damaged issues with examples

Issues WT23-130 all share patterns 1, 3 and 5 (quotes flattened, anchors drifted, emphasis lost). The list below gives what is specific to each one beyond that.

- **WT22** (format): 8 quotes flattened. 8 quotes are a bare `>` line followed by the quote as a plain paragraph, so they render unquoted (email had real `<blockquote>`s; WT1-22 repair did not touch these). e.g. "Stoicism is more a meditative practice..." (line ~229)
- **WT23** (content): 4 quotes flattened; weekly photo missing from body; 5 anchors drifted; 20 anchors unlinked; 2 emphasis spans lost; 2 logo/icon images dropped
- **WT24** (content): 8 quotes flattened; weekly photo missing from body; 10 anchors drifted; 30 anchors unlinked; 2 emphasis spans lost; 2 logo/icon images dropped
- **WT25** (content): 4 quotes flattened; weekly photo missing from body; 14 anchors drifted; 9 anchors unlinked; 2 logo/icon images dropped
- **WT26** (content): 1 quotes flattened; weekly photo missing from body; 9 anchors drifted; 15 anchors unlinked; 2 logo/icon images dropped
- **WT27** (content): 5 quotes flattened; 8 anchors drifted; 22 anchors unlinked; 1 emphasis spans lost; 3 logo/icon images dropped
- **WT28** (content): weekly photo missing from body; 17 anchors drifted; 10 anchors unlinked; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT29** (content): 9 quotes flattened; weekly photo missing from body; 6 anchors drifted; 14 anchors unlinked; 4 emphasis spans lost; 2 logo/icon images dropped
- **WT30** (content): 4 quotes flattened; weekly photo missing from body; 1 micropost photos missing; 9 anchors drifted; 28 anchors unlinked; 2 logo/icon images dropped
- **WT31** (content): 1 quotes flattened; weekly photo missing from body; 6 anchors drifted; 14 anchors unlinked; 3 emphasis spans lost; 2 logo/icon images dropped. Words dropped around links: email "💬 New Driving Change episode with Don Smithmier of Go Kart Labs." -> archive "New [Don Smithmier](..) of [Go Kart Labs](..)."
- **WT32** (content): 4 quotes flattened; weekly photo missing from body; 12 anchors drifted; 2 emphasis spans lost; 3 logo/icon images dropped
- **WT33** (content): weekly photo missing from body; 18 anchors drifted; 1 logo/icon images dropped
- **WT34** (content): 3 quotes flattened; weekly photo missing from body; 16 anchors drifted; 1 anchors unlinked; 2 logo/icon images dropped
- **WT35** (content): 4 quotes flattened; weekly photo missing from body; 12 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT36** (content): 10 quotes flattened; weekly photo missing from body; 6 anchors drifted; 1 emphasis spans lost; 3 logo/icon images dropped
- **WT37** (content): 2 quotes flattened; weekly photo missing from body; 12 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT38** (content): 18 quotes flattened; weekly photo missing from body; 15 anchors drifted; 1 anchors unlinked; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT39** (content): 13 quotes flattened; weekly photo missing from body; 15 anchors drifted; 2 logo/icon images dropped
- **WT40** (content): 9 quotes flattened; weekly photo missing from body; 16 anchors drifted; 1 anchors unlinked; 2 logo/icon images dropped
- **WT41** (content): 7 quotes flattened; weekly photo missing from body; 10 anchors drifted; 2 emphasis spans lost; 2 logo/icon images dropped. Words dropped before a link: email "Notable that Tim Berners-Lee is involved." -> archive "[Tim Berners-Lee](..) is involved."
- **WT42** (content): 9 quotes flattened; weekly photo missing from body; 9 micropost photos missing; 25 anchors drifted; 2 logo/icon images dropped
- **WT43** (content): 6 quotes flattened; weekly photo missing from body; 8 micropost photos missing; 29 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT44** (content): 6 quotes flattened; weekly photo missing from body; 31 micropost photos missing; 3 anchors drifted; 4 emphasis spans lost; 1 logo/icon images dropped. Link-list title duplicated: "What it’s like to be a [What it's like to be a developer at … – Increment: Development](..)"
- **WT45** (content): 5 quotes flattened; weekly photo missing from body; 8 micropost photos missing; 1 anchors drifted; 2 logo/icon images dropped. Link-list title duplicated: "Toys R Us to close all 800 of its [Toys R Us to close all 800 of its U.S. stores - The Washington Post](..)"
- **WT46** (content): 12 quotes flattened; weekly photo missing from body; 2 micropost photos missing; 24 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT47** (content): 2 quotes flattened; weekly photo missing from body; 6 micropost photos missing; 22 anchors drifted; 2 logo/icon images dropped
- **WT48** (content): 4 quotes flattened; weekly photo missing from body; 31 micropost photos missing; 37 anchors drifted; 3 emphasis spans lost; 2 logo/icon images dropped. All 31 micropost photos and the weekly photo missing from body; Promotion/App logos replaced by bare URL lines; titles split ("Halide, Darkroom and Rekindling Photography as [a Hobby - the candler blog](..)"); inline anchors swallow words ("I really want to like Stallman" is all link text; email linked only "Stallman")
- **WT49** (content): 7 quotes flattened; weekly photo missing from body; 5 micropost photos missing; 9 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT50** (content): 6 quotes flattened; weekly photo missing from body; 13 micropost photos missing; 18 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT51** (content): 8 quotes flattened; weekly photo missing from body; 2 micropost photos missing; 33 anchors drifted; 1 logo/icon images dropped
- **WT52** (content): 4 quotes flattened; weekly photo missing from body; 19 micropost photos missing; 33 anchors drifted; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT53** (format): 8 quotes flattened; 8 anchors drifted; 1 emphasis spans lost; 3 logo/icon images dropped
- **WT54** (content): 3 quotes flattened; 19 micropost photos missing; 5 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT55** (content): 7 quotes flattened; 8 micropost photos missing; 5 anchors drifted; 3 logo/icon images dropped
- **WT56** (content): 6 quotes flattened; 9 micropost photos missing; 8 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped. Micropost "Day @ time" headers replaced by bare permalink URLs (9 lines); 9 micropost photos missing
- **WT57** (format): 5 quotes flattened; 7 anchors drifted; 2 logo/icon images dropped
- **WT58** (content): 8 quotes flattened; 4 micropost photos missing; 10 anchors drifted; 1 anchors unlinked; 1 emphasis spans lost; 2 logo/icon images dropped. Micropost headers replaced by bare permalink URLs (8 lines); 4 micropost photos missing
- **WT59** (content): 5 quotes flattened; 3 micropost photos missing; 7 anchors drifted; 1 logo/icon images dropped
- **WT60** (format): 6 quotes flattened; 10 anchors drifted; 1 anchors unlinked; 1 logo/icon images dropped
- **WT61** (content): 8 quotes flattened; 3 micropost photos missing; 23 anchors drifted; 1 anchors unlinked; 1 logo/icon images dropped
- **WT62** (content): 5 quotes flattened; 3 micropost photos missing; 8 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT63** (content): 10 quotes flattened; 12 anchors drifted; 1 logo/icon images dropped. Words dropped inside a sentence: email "Wow, Guido von Rossum, creator of Python, is stepping aside as Benevolent Dictator for Life!" -> archive "[Guido van Rossum](..) , creator of Python, is stepping [Benevolent Dictator for Life](..) !" ("Wow," and "aside as" lost)
- **WT64** (content): 5 quotes flattened; 4 micropost photos missing; 11 anchors drifted; 1 anchors unlinked; 1 emphasis spans lost; 2 logo/icon images dropped
- **WT65** (content): 5 quotes flattened; 5 micropost photos missing; 4 anchors drifted; 1 logo/icon images dropped. 5 micropost photos dropped (Tue 7:50 PM, Tue 7:46 PM, Mon 10:08 PM, Mon 8:36 PM, Mon 7:26 PM); two posts share one wrong permalink (2018/07/31/194646.html); all 5 email blockquotes are plain paragraphs
- **WT66** (content): 6 quotes flattened; 18 anchors drifted; 1 logo/icon images dropped. Two microposts merged and "🐖 Thanks" lost: "Enjoying a delicious lunch at Dinosaur Bar-B-Que [Jason Greenberg](..) @SPSJasonG for the recommendation!"
- **WT67** (format): 2 quotes flattened; 8 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT68** (format): 3 quotes flattened; 6 anchors drifted; 1 logo/icon images dropped
- **WT69** (content): 7 quotes flattened; 4 anchors drifted; 1 anchors unlinked; 3 emphasis spans lost; 2 logo/icon images dropped. Link-list title garbled: "[Exclusive: This is ‘iPhone XS’ — design, larger version, iPhone XS' — design, larger version, and gold colors confirmed | 9to5Mac]"
- **WT70** (content): 2 quotes flattened; 7 anchors drifted; 2 logo/icon images dropped. Four micropost image URLs pasted as one plain-text line (line ~209) above the same images
- **WT71** (format): 6 quotes flattened; 14 anchors drifted; 1 anchors unlinked; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT72** (format): 11 quotes flattened; 7 anchors drifted; 1 anchors unlinked; 3 emphasis spans lost; 3 logo/icon images dropped
- **WT73** (format): 8 quotes flattened; 11 anchors drifted; 4 emphasis spans lost; 1 logo/icon images dropped
- **WT74** (content): 6 quotes flattened; 4 anchors drifted; 1 logo/icon images dropped. Link-list title duplicated and "the morning paper" lost: "[The design and implementation of modern column-oriented The design and implementation of modern column-oriented database systems]"; one plaintext "text (url)" link
- **WT75** (format): 2 quotes flattened; 8 anchors drifted; 3 emphasis spans lost; 1 logo/icon images dropped
- **WT76** (format): 5 quotes flattened; 6 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT77** (format): 8 quotes flattened; 8 anchors drifted; 1 anchors unlinked; 2 logo/icon images dropped
- **WT78** (format): 3 quotes flattened; 2 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT79** (format): 9 quotes flattened; 8 anchors drifted; 1 logo/icon images dropped
- **WT80** (format): 3 quotes flattened; 5 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT81** (format): 6 quotes flattened; 2 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT82** (format): 2 quotes flattened; 8 anchors drifted; 4 emphasis spans lost; 1 logo/icon images dropped
- **WT83** (format): 5 quotes flattened; 1 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT84** (content): 7 quotes flattened; 9 micropost photos missing; 13 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT85** (format): 6 quotes flattened; 7 anchors drifted; 1 logo/icon images dropped
- **WT86** (format): 21 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT87** (format): 3 quotes flattened; 6 anchors drifted; 1 logo/icon images dropped
- **WT88** (format): 2 quotes flattened; 5 anchors drifted; 1 logo/icon images dropped
- **WT89** (format): 5 quotes flattened; 12 anchors drifted; 4 emphasis spans lost; 1 logo/icon images dropped
- **WT90** (format): 4 quotes flattened; 7 anchors drifted; 3 emphasis spans lost; 1 logo/icon images dropped
- **WT91** (content): 2 quotes flattened; 26 micropost photos missing; 9 anchors drifted; 3 emphasis spans lost; 1 logo/icon images dropped
- **WT92** (content): 4 quotes flattened; 4 micropost photos missing; 1 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT93** (format): 1 quotes flattened; 6 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT94** (content): 4 quotes flattened; 5 anchors drifted; 1 logo/icon images dropped. "at Windmere Castle" dropped: email "Quest for the Amulet at Windmere Castle" -> archive "Quest for the Amulet"
- **WT95** (content): 4 quotes flattened; 9 micropost photos missing; 9 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT96** (content): 5 quotes flattened; 6 micropost photos missing; 5 anchors drifted; 1 logo/icon images dropped
- **WT97** (content): 2 quotes flattened; weekly photo missing from body; 4 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped. Link-list title duplicated: "Tesla launches new Supercharger with 1,000 mph charging, [Tesla launches new Supercharger ... - Electrek](..)"; weekly photo missing from body
- **WT98** (content): 9 quotes flattened; 10 micropost photos missing; 10 anchors drifted; 1 logo/icon images dropped
- **WT99** (format): 4 quotes flattened; 5 anchors drifted; 1 logo/icon images dropped
- **WT100** (content): 2 quotes flattened; 3 micropost photos missing; 12 anchors drifted; 6 emphasis spans lost; 1 logo/icon images dropped
- **WT101** (format): 7 quotes flattened; 3 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT102** (content): 5 quotes flattened; 9 micropost photos missing; 12 anchors drifted; 4 emphasis spans lost; 1 logo/icon images dropped
- **WT103** (content): 7 quotes flattened; 2 micropost photos missing; 7 anchors drifted; 2 emphasis spans lost; 1 logo/icon images dropped
- **WT104** (content): 2 quotes flattened; 5 micropost photos missing; 4 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT105** (content): 2 quotes flattened; 10 micropost photos missing; 4 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT106** (content): 9 quotes flattened; 3 micropost photos missing; 16 anchors unlinked; 4 emphasis spans lost; 1 logo/icon images dropped. 20 inline links left as plaintext "text (https://...)"; emphasis Jamie calls out is gone ("**and culture pours out.**" -> plain, next paragraph says "The emphasis is mine there."); 9 blockquotes flattened
- **WT107** (content): 6 quotes flattened; 2 micropost photos missing; 10 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT108** (content): 7 quotes flattened; 7 micropost photos missing; 6 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT109** (content): 4 quotes flattened; weekly photo missing from body; 5 anchors drifted; 1 logo/icon images dropped. Weekly photo missing from body (cover only in front matter)
- **WT110** (content): 3 quotes flattened; 3 micropost photos missing; 2 anchors drifted; 1 emphasis spans lost; 1 logo/icon images dropped
- **WT111** (content): 8 quotes flattened; 6 micropost photos missing; 9 anchors drifted; 5 emphasis spans lost; 1 logo/icon images dropped
- **WT112** (format): 2 quotes flattened; 7 anchors drifted; 1 logo/icon images dropped
- **WT113** (format): 5 quotes flattened; 1 anchors drifted
- **WT114** (content): 2 quotes flattened; 6 micropost photos missing; 2 anchors drifted
- **WT115** (format): 5 quotes flattened; 7 anchors drifted
- **WT116** (content): 5 quotes flattened; 2 micropost photos missing; 1 anchors drifted; 1 emphasis spans lost
- **WT117** (format): 5 quotes flattened; 3 anchors drifted; 1 emphasis spans lost
- **WT118** (content): 12 quotes flattened; 6 micropost photos missing; 16 anchors drifted
- **WT119** (content): 3 quotes flattened; 2 micropost photos missing; 6 anchors drifted; 1 emphasis spans lost
- **WT120** (content): 6 quotes flattened; 5 anchors drifted; 1 anchors unlinked. Link-list title duplicated with a different wording: "Bike crash left Spokane man unconscious, so his Apple Watch [Bike crash left Spokane man unconscious, but his Apple Watch called 911 — The Seattle Times](..)"; "Where to find the hours" retitled "How to find the hours"
- **WT121** (content): 4 quotes flattened; 5 micropost photos missing; 8 anchors drifted; 1 emphasis spans lost
- **WT122** (format): 8 quotes flattened; 8 anchors drifted
- **WT123** (content): 6 quotes flattened; 5 micropost photos missing; 9 anchors drifted; 4 emphasis spans lost
- **WT124** (content): 5 quotes flattened; 4 micropost photos missing; 9 anchors drifted; 1 emphasis spans lost
- **WT125** (content): 6 quotes flattened; 4 micropost photos missing; 3 anchors drifted
- **WT126** (content): 4 quotes flattened; 12 micropost photos missing; 9 anchors drifted; 1 emphasis spans lost
- **WT127** (format): 10 quotes flattened; 14 anchors drifted; 2 emphasis spans lost
- **WT128** (format): 4 quotes flattened; 14 anchors drifted
- **WT129** (format): 7 quotes flattened; 8 anchors drifted; 2 emphasis spans lost
- **WT130** (content): 4 quotes flattened; 3 micropost photos missing; 11 anchors drifted; 1 emphasis spans lost

Example quotes flattened (first per issue, sample):

- WT22: "Though it is unclear whether men or women are more accurate, many people are obviously ignorant about the reality of their partners’ lives. And even i..."
- WT37: "The market can’t fix this because neither the buyer nor the seller cares. The owners of the webcams and DVRs used in the denial-of-service attacks don..."
- WT38: "Unlike generations thereafter, if kids of the seventies wanted to see innovative technology, they’d have to build it themselves — they had no other ch..."
- WT39: "Our three-year study, which we released recently, shows that nfx are responsible for 70% of the value created by tech companies since the Internet bec..."
- WT40: "The answer to the passive consumption of trash is the active formulation of questions, the active search for answers and the active work of putting co..."
- WT41: "Teach your code to communicate with your team, and you will reap the benefits for as long as the code lives!..."
- WT42: "Facebook is about making money by keeping us addicted to Facebook. It always has been — and that’s why all of our angst and headlines are not going to..."
- WT43: "GitHub briefly struggled with intermittent outages as a digital system assessed the situation. Within 10 minutes it had automatically called for help ..."
- WT24 (italic in email): "Talking about how technical teams make decisions, I often see a complete lack of understanding how to relate the business issues their organisation fa..."
- WT36 (italic in email): "Use airflow to author workflows as directed acyclic graphs (DAGs) of tasks. The airflow scheduler executes your tasks on an array of workers while fol..."

## Minor issues

- WT18: 1 glued "comment > quote" line(s), present in the email too
- WT19: 1 glued "comment > quote" line(s), present in the email too

## Per-issue triage table

quotes = email quotes rendered as plain text; drift/unl = anchors whose link boundary moved / link lost; photos = weekly photo + micropost photos missing from body; logos = Give Back/App icons dropped; emph = bold/italic spans lost.

| WT | era | triage | quotes | drift | unl | photos | logos | emph | anchors |
|---|---|---|---|---|---|---|---|---|---|
| 1 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 21 |
| 2 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 27 |
| 6 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 40 |
| 7 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 8 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 9 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 10 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 48 |
| 11 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 38 |
| 12 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 50 |
| 13 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 49 |
| 14 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 49 |
| 15 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 53 |
| 16 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 49 |
| 17 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 37 |
| 18 | TinyLetter | minor | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 19 | TinyLetter | minor | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 20 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 77 |
| 21 | TinyLetter | clean | 0 | 0 | 0 | 0 | 0 | 0 | 51 |
| 22 | TinyLetter | damaged (format) | 8 | 0 | 0 | 0 | 0 | 0 | 55 |
| 23 | MailChimp | damaged (content) | 4 | 5 | 20 | 1 | 2 | 2 | 69 |
| 24 | MailChimp | damaged (content) | 8 | 10 | 30 | 1 | 2 | 2 | 80 |
| 25 | MailChimp | damaged (content) | 4 | 14 | 9 | 1 | 2 | 0 | 61 |
| 26 | MailChimp | damaged (content) | 1 | 9 | 15 | 1 | 2 | 0 | 68 |
| 27 | MailChimp | damaged (content) | 5 | 8 | 22 | 0 | 3 | 1 | 73 |
| 28 | MailChimp | damaged (content) | 0 | 17 | 10 | 1 | 1 | 2 | 62 |
| 29 | MailChimp | damaged (content) | 9 | 6 | 14 | 1 | 2 | 4 | 65 |
| 30 | MailChimp | damaged (content) | 4 | 9 | 28 | 2 | 2 | 0 | 75 |
| 31 | MailChimp | damaged (content) | 1 | 6 | 14 | 1 | 2 | 3 | 61 |
| 32 | MailChimp | damaged (content) | 4 | 12 | 0 | 1 | 3 | 2 | 69 |
| 33 | MailChimp | damaged (content) | 0 | 18 | 0 | 1 | 1 | 0 | 53 |
| 34 | MailChimp | damaged (content) | 3 | 16 | 1 | 1 | 2 | 0 | 61 |
| 35 | MailChimp | damaged (content) | 4 | 12 | 0 | 1 | 1 | 1 | 55 |
| 36 | MailChimp | damaged (content) | 10 | 6 | 0 | 1 | 3 | 1 | 53 |
| 37 | MailChimp | damaged (content) | 2 | 12 | 0 | 1 | 2 | 1 | 45 |
| 38 | MailChimp | damaged (content) | 18 | 15 | 1 | 1 | 2 | 1 | 70 |
| 39 | MailChimp | damaged (content) | 13 | 15 | 0 | 1 | 2 | 0 | 51 |
| 40 | MailChimp | damaged (content) | 9 | 16 | 1 | 1 | 2 | 0 | 57 |
| 41 | MailChimp | damaged (content) | 7 | 10 | 0 | 1 | 2 | 2 | 52 |
| 42 | MailChimp | damaged (content) | 9 | 25 | 0 | 10 | 2 | 0 | 48 |
| 43 | MailChimp | damaged (content) | 6 | 29 | 0 | 9 | 2 | 1 | 73 |
| 44 | MailChimp | damaged (content) | 6 | 3 | 0 | 32 | 1 | 4 | 52 |
| 45 | MailChimp | damaged (content) | 5 | 1 | 0 | 9 | 2 | 0 | 36 |
| 46 | MailChimp | damaged (content) | 12 | 24 | 0 | 3 | 2 | 1 | 58 |
| 47 | MailChimp | damaged (content) | 2 | 22 | 0 | 7 | 2 | 0 | 45 |
| 48 | MailChimp | damaged (content) | 4 | 37 | 0 | 32 | 2 | 3 | 83 |
| 49 | MailChimp | damaged (content) | 7 | 9 | 0 | 6 | 2 | 1 | 42 |
| 50 | MailChimp | damaged (content) | 6 | 18 | 0 | 14 | 2 | 1 | 77 |
| 51 | MailChimp | damaged (content) | 8 | 33 | 0 | 3 | 1 | 0 | 52 |
| 52 | MailChimp | damaged (content) | 4 | 33 | 0 | 20 | 2 | 1 | 85 |
| 53 | MailChimp | damaged (format) | 8 | 8 | 0 | 0 | 3 | 1 | 49 |
| 54 | MailChimp | damaged (content) | 3 | 5 | 0 | 19 | 1 | 2 | 75 |
| 55 | MailChimp | damaged (content) | 7 | 5 | 0 | 8 | 3 | 0 | 57 |
| 56 | MailChimp | damaged (content) | 6 | 8 | 0 | 9 | 1 | 2 | 50 |
| 57 | MailChimp | damaged (format) | 5 | 7 | 0 | 0 | 2 | 0 | 64 |
| 58 | MailChimp | damaged (content) | 8 | 10 | 1 | 4 | 2 | 1 | 52 |
| 59 | MailChimp | damaged (content) | 5 | 7 | 0 | 3 | 1 | 0 | 64 |
| 60 | MailChimp | damaged (format) | 6 | 10 | 1 | 0 | 1 | 0 | 59 |
| 61 | MailChimp | damaged (content) | 8 | 23 | 1 | 3 | 1 | 0 | 90 |
| 62 | MailChimp | damaged (content) | 5 | 8 | 0 | 3 | 1 | 1 | 52 |
| 63 | MailChimp | damaged (content) | 10 | 12 | 0 | 0 | 1 | 0 | 65 |
| 64 | MailChimp | damaged (content) | 5 | 11 | 1 | 4 | 2 | 1 | 65 |
| 65 | MailChimp | damaged (content) | 5 | 4 | 0 | 5 | 1 | 0 | 52 |
| 66 | MailChimp | damaged (content) | 6 | 18 | 0 | 0 | 1 | 0 | 71 |
| 67 | MailChimp | damaged (format) | 2 | 8 | 0 | 0 | 1 | 2 | 59 |
| 68 | MailChimp | damaged (format) | 3 | 6 | 0 | 0 | 1 | 0 | 41 |
| 69 | MailChimp | damaged (content) | 7 | 4 | 1 | 0 | 2 | 3 | 53 |
| 70 | MailChimp | damaged (content) | 2 | 7 | 0 | 0 | 2 | 0 | 44 |
| 71 | MailChimp | damaged (format) | 6 | 14 | 1 | 0 | 1 | 2 | 69 |
| 72 | MailChimp | damaged (format) | 11 | 7 | 1 | 0 | 3 | 3 | 61 |
| 73 | MailChimp | damaged (format) | 8 | 11 | 0 | 0 | 1 | 4 | 70 |
| 74 | MailChimp | damaged (content) | 6 | 4 | 0 | 0 | 1 | 0 | 41 |
| 75 | MailChimp | damaged (format) | 2 | 8 | 0 | 0 | 1 | 3 | 67 |
| 76 | MailChimp | damaged (format) | 5 | 6 | 0 | 0 | 1 | 2 | 61 |
| 77 | MailChimp | damaged (format) | 8 | 8 | 1 | 0 | 2 | 0 | 59 |
| 78 | MailChimp | damaged (format) | 3 | 2 | 0 | 0 | 1 | 2 | 38 |
| 79 | MailChimp | damaged (format) | 9 | 8 | 0 | 0 | 1 | 0 | 54 |
| 80 | MailChimp | damaged (format) | 3 | 5 | 0 | 0 | 1 | 2 | 47 |
| 81 | MailChimp | damaged (format) | 6 | 2 | 0 | 0 | 1 | 2 | 58 |
| 82 | MailChimp | damaged (format) | 2 | 8 | 0 | 0 | 1 | 4 | 56 |
| 83 | MailChimp | damaged (format) | 5 | 1 | 0 | 0 | 1 | 1 | 38 |
| 84 | MailChimp | damaged (content) | 7 | 13 | 0 | 9 | 1 | 1 | 64 |
| 85 | MailChimp | damaged (format) | 6 | 7 | 0 | 0 | 1 | 0 | 41 |
| 86 | MailChimp | damaged (format) | 0 | 21 | 0 | 0 | 1 | 2 | 60 |
| 87 | MailChimp | damaged (format) | 3 | 6 | 0 | 0 | 1 | 0 | 39 |
| 88 | MailChimp | damaged (format) | 2 | 5 | 0 | 0 | 1 | 0 | 47 |
| 89 | MailChimp | damaged (format) | 5 | 12 | 0 | 0 | 1 | 4 | 62 |
| 90 | MailChimp | damaged (format) | 4 | 7 | 0 | 0 | 1 | 3 | 43 |
| 91 | MailChimp | damaged (content) | 2 | 9 | 0 | 26 | 1 | 3 | 55 |
| 92 | MailChimp | damaged (content) | 4 | 1 | 0 | 4 | 1 | 1 | 52 |
| 93 | MailChimp | damaged (format) | 1 | 6 | 0 | 0 | 1 | 2 | 38 |
| 94 | MailChimp | damaged (content) | 4 | 5 | 0 | 0 | 1 | 0 | 51 |
| 95 | MailChimp | damaged (content) | 4 | 9 | 0 | 9 | 1 | 1 | 50 |
| 96 | MailChimp | damaged (content) | 5 | 5 | 0 | 6 | 1 | 0 | 50 |
| 97 | MailChimp | damaged (content) | 2 | 4 | 0 | 1 | 1 | 1 | 35 |
| 98 | MailChimp | damaged (content) | 9 | 10 | 0 | 10 | 1 | 0 | 56 |
| 99 | MailChimp | damaged (format) | 4 | 5 | 0 | 0 | 1 | 0 | 31 |
| 100 | MailChimp | damaged (content) | 2 | 12 | 0 | 3 | 1 | 6 | 58 |
| 101 | MailChimp | damaged (format) | 7 | 3 | 0 | 0 | 1 | 1 | 48 |
| 102 | MailChimp | damaged (content) | 5 | 12 | 0 | 9 | 1 | 4 | 67 |
| 103 | MailChimp | damaged (content) | 7 | 7 | 0 | 2 | 1 | 2 | 48 |
| 104 | MailChimp | damaged (content) | 2 | 4 | 0 | 5 | 1 | 1 | 40 |
| 105 | MailChimp | damaged (content) | 2 | 4 | 0 | 10 | 1 | 1 | 45 |
| 106 | MailChimp | damaged (content) | 9 | 0 | 16 | 3 | 1 | 4 | 37 |
| 107 | MailChimp | damaged (content) | 6 | 10 | 0 | 2 | 1 | 1 | 42 |
| 108 | MailChimp | damaged (content) | 7 | 6 | 0 | 7 | 1 | 1 | 57 |
| 109 | MailChimp | damaged (content) | 4 | 5 | 0 | 1 | 1 | 0 | 34 |
| 110 | MailChimp | damaged (content) | 3 | 2 | 0 | 3 | 1 | 1 | 31 |
| 111 | MailChimp | damaged (content) | 8 | 9 | 0 | 6 | 1 | 5 | 52 |
| 112 | MailChimp | damaged (format) | 2 | 7 | 0 | 0 | 1 | 0 | 35 |
| 113 | MailChimp | damaged (format) | 5 | 1 | 0 | 0 | 0 | 0 | 29 |
| 114 | MailChimp | damaged (content) | 2 | 2 | 0 | 6 | 0 | 0 | 43 |
| 115 | MailChimp | damaged (format) | 5 | 7 | 0 | 0 | 0 | 0 | 39 |
| 116 | MailChimp | damaged (content) | 5 | 1 | 0 | 2 | 0 | 1 | 33 |
| 117 | MailChimp | damaged (format) | 5 | 3 | 0 | 0 | 0 | 1 | 42 |
| 118 | MailChimp | damaged (content) | 12 | 16 | 0 | 6 | 0 | 0 | 56 |
| 119 | MailChimp | damaged (content) | 3 | 6 | 0 | 2 | 0 | 1 | 43 |
| 120 | MailChimp | damaged (content) | 6 | 5 | 1 | 0 | 0 | 0 | 34 |
| 121 | MailChimp | damaged (content) | 4 | 8 | 0 | 5 | 0 | 1 | 48 |
| 122 | MailChimp | damaged (format) | 8 | 8 | 0 | 0 | 0 | 0 | 51 |
| 123 | MailChimp | damaged (content) | 6 | 9 | 0 | 5 | 0 | 4 | 53 |
| 124 | MailChimp | damaged (content) | 5 | 9 | 0 | 4 | 0 | 1 | 58 |
| 125 | MailChimp | damaged (content) | 6 | 3 | 0 | 4 | 0 | 0 | 40 |
| 126 | MailChimp | damaged (content) | 4 | 9 | 0 | 12 | 0 | 1 | 57 |
| 127 | MailChimp | damaged (format) | 10 | 14 | 0 | 0 | 0 | 2 | 60 |
| 128 | MailChimp | damaged (format) | 4 | 14 | 0 | 0 | 0 | 0 | 54 |
| 129 | MailChimp | damaged (format) | 7 | 8 | 0 | 0 | 0 | 2 | 59 |
| 130 | MailChimp | damaged (content) | 4 | 11 | 0 | 3 | 0 | 1 | 52 |
| 131 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 57 |
| 132 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 50 |
| 133 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 134 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 48 |
| 135 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 45 |
| 136 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 40 |
| 137 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 84 |
| 138 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 139 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 140 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 140-special | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 10 |
| 141 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 142 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 143 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 53 |
| 144 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 90 |
| 145 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 69 |
| 146 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| 147 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 148 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 81 |
| 149 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 150 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 151 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| 152 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 78 |
| 153 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 154 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 68 |
| 155 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 86 |
| 156 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 56 |
| 157 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 89 |
| 158 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 76 |
| 159 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 69 |
| 160 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 161 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 92 |
| 162 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 163 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 82 |
| 164 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 74 |
| 165 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 85 |
| 166 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 167 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 168 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 169 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 170 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 82 |
| 171 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 57 |
| 172 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 173 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 94 |
| 174 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 75 |
| 175 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 81 |
| 176 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 177 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 127 |
| 178 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 54 |
| 179 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 58 |
| 180 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 181 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 53 |
| 182 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 94 |
| 183 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| 184 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 101 |
| 185 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 94 |
| 186 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 187 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 188 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 103 |
| 189 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 190 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 81 |
| 191 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 87 |
| 192 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 128 |
| 193 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 194 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 195 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 93 |
| 196 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 76 |
| 197 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 198 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 57 |
| 199 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 200 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 106 |
| 201 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 110 |
| 202 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 203 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 98 |
| 204 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 205 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 206 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 207 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 208 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 209 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 64 |
| 210 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 211 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 212 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 92 |
| 213 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 35 |
| 214 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 64 |
| 215 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 216 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 78 |
| 217 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 103 |
| 218 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 219 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 68 |
| 220 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 55 |
| 221 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 222 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 223 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 84 |
| 224 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 87 |
| 225 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 226 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 95 |
| 227 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 228 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 229 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 230 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 50 |
| 231 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 232 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 233 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 234 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 235 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 64 |
| 236 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 237 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 238 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 239 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 44 |
| 240 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 241 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 64 |
| 242 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 243 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| 244 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 245 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 87 |
| 246 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 48 |
| 247 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 248 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 83 |
| 249 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 250 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 251 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 252 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 253 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 254 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 66 |
| 255 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 78 |
| 256 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 98 |
| 257 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 74 |
| 258 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 96 |
| 259 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 91 |
| 260 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 95 |
| 261 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 63 |
| 262 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 68 |
| 263 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| 264 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 265 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 61 |
| 266 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 267 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 86 |
| 268 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 269 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 270 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 70 |
| 271 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 66 |
| 272 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 108 |
| 273 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 86 |
| 274 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 151 |
| 275 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 87 |
| 276 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 70 |
| 277 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 58 |
| 278 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 103 |
| 279 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 280 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 78 |
| 281 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 128 |
| 282 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 58 |
| 283 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 284 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 69 |
| 285 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 104 |
| 286 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 69 |
| 287 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 87 |
| 288 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 289 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 290 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 291 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 101 |
| 292 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 66 |
| 293 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 294 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 114 |
| 295 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 63 |
| 296 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 70 |
| 297 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 89 |
| 298 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 86 |
| 299 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 60 |
| 300 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 48 |
| 301 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 118 |
| 302 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 110 |
| 303 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 82 |
| 304 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 95 |
| 305 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| 306 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 93 |
| 307 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 68 |
| 308 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 309 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 66 |
| 310 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 103 |
| 311 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 61 |
| 312 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 47 |
| 313 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 314 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 315 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 316 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 61 |
| 317 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 120 |
| 318 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 319 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 97 |
| 320 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 88 |
| 321 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 78 |
| 322 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 12 |
| 323 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 324 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 104 |
| 325 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 82 |
| 326 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 57 |
| 327 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 70 |
| 328 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 75 |
| 329 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 95 |
| 330 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 82 |
| 331 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 332 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 67 |
| 333 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 106 |
| 334 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 71 |
| 335 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 56 |
| 336 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 62 |
| 337 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 89 |
| 338 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 72 |
| 339 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 66 |
| 340 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 64 |
| 341 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 41 |
| 342 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 52 |
| 343 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 50 |
| 344 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 48 |
| 345 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 47 |
| 346 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 347 | Buttondown | clean | 0 | 0 | 0 | 0 | 0 | 0 | 65 |
| 348 | WT Builder | clean | 0 | 0 | 0 | 0 | 0 | 0 | 59 |
| 349 | WT Builder | clean | 0 | 0 | 0 | 0 | 0 | 0 | 42 |
| 350 | WT Builder | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 351 | WT Builder | clean | 0 | 0 | 0 | 0 | 0 | 0 | 46 |
| 352 | WT Builder | clean | 0 | 0 | 0 | 0 | 0 | 0 | 73 |
| 3, 4, 5 | TinyLetter | no email | | | | | | | |

## What a repair would involve

The emails are a complete, faithful source for WT23-130, so the repair is mechanical. Re-derive the body from the HTML part instead of the plain text, keep the archive's section structure, and apply it as a reviewed diff. Rough shape:

1. **Quotes (WT22-130, about 580 passages).** For each email `<blockquote>` (38-130) or long `<em>` excerpt (23-37), find the matching archive paragraph and prefix it with `> `, splitting off any trailing Jamie comment the way the WT1-22 commit did. WT22: join the 8 bare `>` lines to their following paragraph. Fully scriptable; review a sample per year. This is the highest-value fix (attribution, Thingy voice filter, audio).
2. **Photos (WT23-130, 31 weekly photos and about 356 micropost photos).** Weekly photo: insert `![caption](cover.jpg URL from front matter)` under the Photo heading for WT23-52, 97 and 109; the files already exist. Micropost photos: the email gives each `micro.thingelstad.com/uploads/YYYY/<hash>.jpg`, and the same file names already resolve on `cdn.uploads.micro.blog/890/` for the kept ones. Place them under their micropost by matching the post text. Needs a HEAD check on the rehost host before writing; that is a network step, outside this audit.
3. **Link boundaries (WT23-130, about 1,000 anchors).** For each email `<a>` (anchor text + resolved href; the MailChimp redirect hrefs need mapping to the archive URL by order within the paragraph), reset the bracket span in the archive line to the email anchor text. Same mechanics as `fix_link_list_anchors.py`, extended to inline links and to WT42-52 list titles. WT23-31 micropost permalinks can be re-linked from the email anchors. Moderate effort; the main risk is mis-mapping when one paragraph has several links, so gate on "exact anchor text found once in line".
4. **Hand fixes (about 14 issues):** WT31, 41, 44, 45, 56, 58, 63, 66, 69, 70, 74, 94, 97, 106, 120 as listed above. WT106 needs its 20 plain-text links linkified.
5. **Emphasis (132 spans) and logo lines (about 140 bare-URL lines).** Restore `**`/`_` from the email; delete or convert the bare-URL lines. Low value, easy to do in the same pass.
6. Afterwards regenerate `links.json`/front-matter `links` and `word_count` (as the WT1-22 commit did), then re-run this audit (`/tmp/wtq/audit/audit.py`) to confirm WT23-130 come out clean.

A practical order: (1) quotes, (2) weekly photos, (3) WT42-52 split titles and the hand-fix list, then (4) inline anchor drift and micropost photos, which need the most care. Reconstruction from HTML would be about one script plus a few hours of per-era spot review. Nothing outside WT22-130 needs repair.

## Files

- `/tmp/wtq/audit/inventory.py` -> `inventory.json` (email to issue mapping)
- `/tmp/wtq/audit/audit.py` -> `results.json` (per-issue sentences, anchors, headings, images, quotes)
- `imgs.py` -> `imgs.json`; `emph.py` -> `emph.json`; `italq.py` -> `italq.json`; `worddiff.py` -> `worddiff.json`; `shortlines.py`; `dupgram.py`
- `report.py` -> this file. Run with `/Users/otto/Projects/thingelstad.com/librarian-thing/.venv/bin/python` (needs bs4).

## Repair log

Jamie approved the repair on 2026-10-06: "repair WT23–130 from the sent emails in librarian-thing and weekly.thingelstad.com, quotes first, re-rendering audio for changed issues". Jamie can't review it by hand, so each round runs four checks:

- a validator written separately from the apply script, rendered with the site's markdown-it;
- planted faults the validator must catch;
- an independent adversarial review against the emails;
- `make check` plus the CI corpus gate.

**Round 1, quotes** (`repair/`). 564 quotes in 103 issues are blockquotes again (317661ff). The validator checks:

- the text is unchanged apart from `>` markers;
- every email quote renders as a quote, and nothing else does;
- no heading sits inside a quote;
- quote edges and punctuation match the email.

**Round 2, weekly photos** (`repair/photos/`). 30 issues get their photo back: 23–26, 28, 30–52, 97 and 109.

- The image is the issue's cover, which `sweep.py` shows is pixel-identical to the email photo in every case. The alt is the email's.
- Placement follows the email in WT23–52. WT97 and WT109 follow the WT53–130 convention (photo right under the heading), which every surviving section in that era uses.
- WT39–41 get back the "Photo 📷" heading. WT32–38's "Photog" headings are corrected to the emails' "Photo".
- The covers of WT31 (a waterfall) and WT32 (an EFF member badge) were different pictures, so the email photos replaced them on S3. The old versions are kept, CloudFront was invalidated, and the vision descriptions were redone (`describe_media.py --url`).
- WT29's photo is gone everywhere (dead MailChimp URL, no archive copy), so it stays without one. Its dead cover URL and WT27's App Store "Placeholder" image are cleared to `''`, as WT1 is.
- Left as found: WT97's "Dreaming of summer." line (the email's alt, flattened into text at import) and WT36's "thick" (the email says "think").
