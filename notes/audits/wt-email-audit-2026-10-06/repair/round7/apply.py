"""Round 7: the closing-check fixes. Approved by Jamie 2026-10-07: WT74's title, the
alt-text caption lines in WT57/60/62/70/97/110/125, WT77's photo date, the Mailchimp
link placements, and A-D (bare App Store/Amazon lines, dead blog permalinks, the empty
Supporting Membership heading, Buttondown buttons). Body edits only; regen_meta.py
then recomputes front matter and links.json. Every edit names its exact old text and
must match the expected number of times. Run from librarian-thing."""
import json, re, sys
from collections import defaultdict
from pathlib import Path

write = "--write" in sys.argv
E = defaultdict(list)   # issue -> [(category, old, new)]
def ed(cat, n, old, new): E[n].append((cat, old, new))

# --- WT74: doubled title -------------------------------------------------------
ed("title", 74, "[The design and implementation of modern column-oriented The design and implementation of modern column-oriented database systems]",
   "[The design and implementation of modern column-oriented database systems]")

# --- alt text copied in as a caption line above the photo's date ------------------
for n, cap, date in [
    (57, "The sun setting after a fabulous day of fun on Cannon Lake.", "Jun 2, 2018 at 8:46 PM"),
    (60, "Fairy house in the base of a tree.", "Jun 24, 2018 at 8:03 PM"),
    (62, "Cornfield with barn in background.", "Jul 6, 2018 at 2:51 PM"),
    (70, "Fairy House at Minnesota Renaissance Festival.", "Sep 3, 2018 at 1:00 PM"),
    (97, "Dreaming of summer.", "Mar 9, 2019 at 2:33 PM"),
    (110, "Giant slip-n-slide in Newton Sledding Hill in South Minneapolis.", "Jun 8, 2019 at 4:03 PM"),
    (125, "Downtown Minneapolis at night from Lake Calhoun.", "Nov 7, 2019 at 8:25 PM")]:
    ed("caption", n, f"\n\n{cap}\n{date}\n", f"\n\n{date}\n")

# --- WT77: the photo's date line ---------------------------------------------
ed("photo-date", 77, "🍁\n\n300 Eagle Dr, Park Rapids MN\n", "🍁\n\nOct 20, 2018 at 12:40 PM\n300 Eagle Dr, Park Rapids MN\n")

# --- Mailchimp-era anchors: link the email's words, keep the archive's URLs -----
L = lambda n, o, w: ed("anchor", n, o, w)
L(23, "[Highlighting how Sephora](https://www.sephora.com) has", "Highlighting how [Sephora](https://www.sephora.com) has")
L(24, "[I hadn't heard of Bitmark](https://bitmark.com) but", "I hadn't heard of [Bitmark](https://bitmark.com) but")
L(24, "[I’ve read a bit about RDF](https://en.wikipedia.org/wiki/RDFa) [and OWL](https://en.wikipedia.org/wiki/Web_Ontology_Language) and",
      "I’ve read a bit about [RDF](https://en.wikipedia.org/wiki/RDFa) and [OWL](https://en.wikipedia.org/wiki/Web_Ontology_Language) and")
L(24, "This [article is vendor-written to support GRAKN.AI](https://grakn.ai/) but", "This article is vendor-written to support [GRAKN.AI](https://grakn.ai/) but")
L(24, "First public beta of the micro.blog Mac app is now out. I’m still enjoying [using micro.blog and publishing Micro Thing](https://www.thingelstad.com/) ! 👏",
      "First public beta of the [micro.blog](https://micro.blog) Mac app is now out. I’m still enjoying using micro.blog and publishing [Micro Thing](https://www.thingelstad.com/)! 👏")
L(25, "nice on the [surface. Read the about the motivation](https://dramatiq.io/motivation.html) .", "nice on the surface. Read the about the [motivation](https://dramatiq.io/motivation.html).")
L(25, "[When I was still building WikiApiary](https://wikiapiary.com/wiki/Main_Page) I", "When I was still building [WikiApiary](https://wikiapiary.com/wiki/Main_Page) I")
L(27, "[I’m excited that my book club](https://rwbook.club) picked", "I’m excited that [my book club](https://rwbook.club) picked")
L(29, "article [totally made me think of GTD](http://gettingthingsdone.com) and", "article totally made me think of [GTD](http://gettingthingsdone.com) and")
L(69, "[When I was at David Hussman](https://www.thingelstad.com/2018/goodbye-to-my-friend-david-hussman/) 's memorial", "When I was at [David Hussman](https://www.thingelstad.com/2018/goodbye-to-my-friend-david-hussman/)'s memorial")
L(77, "[Fun (and chilly!) day playing Kubb](https://en.wikipedia.org/wiki/Kubb) and", "Fun (and chilly!) day playing [Kubb](https://en.wikipedia.org/wiki/Kubb) and")
L(82, "Cotton Headed [Ninny Muggins! Christmas tradition, watching Elf](https://en.wikipedia.org/wiki/Elf_(film)) !", "Cotton Headed Ninny Muggins! Christmas tradition, watching [Elf](https://en.wikipedia.org/wiki/Elf_(film))!")
L(26, "my [fellow Minnestar board member Jenna Pederson](http://jennapederson.com) . For", "my fellow [Minnestar](https://minnestar.org) board member [Jenna Pederson](http://jennapederson.com). For")
L(27, "make a [simple website for the Weekly Thing](https://weekly.thingelstad.com)  with", "make a simple [website for the Weekly Thing](https://weekly.thingelstad.com) with")
L(27, "This made [me think of the Hunger Games](https://en.wikipedia.org/wiki/The_Hunger_Games) .", "This made me think of the [Hunger Games](https://en.wikipedia.org/wiki/The_Hunger_Games).")
L(28, "[jump into the Micro.blog Photo Challenge](http://micro.douglane.com/2017/11/09/microblog-photo-challenge.html) . 📷",
      "jump into the [Micro.blog Photo Challenge](http://micro.douglane.com/2017/11/09/microblog-photo-challenge.html). 📷")
_u = "http://www.thingelstad.com/2017/11/"
L(28, f"[a theme for each day: Squares]({_u}11/193440.html) [, Tasty]({_u}12/191007.html) [, On the Move]({_u}13/234858.html) [, Up Close]({_u}14/015301.html) [, Liquid]({_u}15/012043.html) [, Seasonal]({_u}16/001031.html) [, and Shadow]({_u}17/021039.html) .",
      f"a theme for each day: [Squares]({_u}11/193440.html), [Tasty]({_u}12/191007.html), [On the Move]({_u}13/234858.html), [Up Close]({_u}14/015301.html), [Liquid]({_u}15/012043.html), [Seasonal]({_u}16/001031.html), and [Shadow]({_u}17/021039.html).")
L(29, "-- [Hello! 👋 My friend David Hussman](https://twitter.com/davidhussman) [shared this](https://www.linkedin.com/feed/update/urn:li:activity:6337711918261825537) , and",
      "-- Hello! 👋 My friend [David Hussman](https://twitter.com/davidhussman) [shared this](https://www.linkedin.com/feed/update/urn:li:activity:6337711918261825537), and")
L(30, "[A FOSS](https://en.wikipedia.org/wiki/Free_and_open-source_software) option", "A [FOSS](https://en.wikipedia.org/wiki/Free_and_open-source_software) option")
L(32, "about [this song. Thanks to Steve Yaeger](https://twitter.com/SteveYaeger) for", "about this song. Thanks to [Steve Yaeger](https://twitter.com/SteveYaeger) for")
L(34, "I love [this call out from Jaron Lanier](https://en.wikipedia.org/wiki/Jaron_Lanier) :", "I love this call out from [Jaron Lanier](https://en.wikipedia.org/wiki/Jaron_Lanier):")
L(35, "taking [Shawn Blanc's Focus Course](https://thefocuscourse.com) . 🧘", "taking [Shawn Blanc](https://shawnblanc.net)'s [Focus Course](https://thefocuscourse.com). 🧘")
L(35, "I [shared my frustration with the reporting](https://www.thingelstad.com/2017/12/29/i-want-to.html)", "I shared my [frustration with the reporting](https://www.thingelstad.com/2017/12/29/i-want-to.html)")
L(36, "overview [of how they have deployed Kubernetes](https://kubernetes.io) at", "overview of how they have deployed [Kubernetes](https://kubernetes.io) at")
L(37, "[A home-built Raspberry Pi](https://www.raspberrypi.org) [Kubernetes]", "A home-built [Raspberry Pi](https://www.raspberrypi.org) [Kubernetes]")
L(40, "[Make sure to read part 2](", "Make sure to read [part 2](")
L(41, "Brent has [a history with readers having created](http://inessential.com/apps_ive_made) NetNewsWire", "Brent has a history with readers [having created](http://inessential.com/apps_ive_made) NetNewsWire")
L(41, "You should [support this](https://supporters.eff.org/donate) , even", "[You should support this](https://supporters.eff.org/donate), even")
L(49, "using something like micro.blog to publish", "using something like [micro.blog](https://micro.blog) to publish")
L(50, "highlighted in [the April 13th issue of Noticing](https://mailchi.mp/kottke/blogging-is-not-dead-edition-2575912502) , the",
      "highlighted in the [April 13th issue of Noticing](https://mailchi.mp/kottke/blogging-is-not-dead-edition-2575912502), the")
L(50, "[The Master Switch](https://www.amazon.com/Master-Switch-Rise-Information-Empires/dp/0307390993/) , which", "[The Master Switch](https://www.amazon.com/Master-Switch-Rise-Information-Empires/dp/0307390993/), which")
L(52, "which [is bundled in with Eero Plus](https://eero.com/plus) ,", "which is bundled in with [Eero Plus](https://eero.com/plus),")
L(54, "[“At SPS it might be Kube](https://kubernetes.io) [or Kubb](https://en.wikipedia.org/wiki/Kubb) [!” Kelly Hamm](https://www.linkedin.com/in/hammkelly/) [at SumoLogic](https://www.sumologic.com) knows",
      "“At SPS it might be [Kube](https://kubernetes.io) or [Kubb](https://en.wikipedia.org/wiki/Kubb)!” [Kelly Hamm](https://www.linkedin.com/in/hammkelly/) at [SumoLogic](https://www.sumologic.com) knows")
L(61, "Rainy [morning 🌧, playing The Magic Labyrinth](https://en.wikipedia.org/wiki/The_Magic_Labyrinth_(board_game)) . 🎲", "Rainy morning 🌧, playing [The Magic Labyrinth](https://en.wikipedia.org/wiki/The_Magic_Labyrinth_(board_game)). 🎲")
L(70, "[We are enjoying Making It](https://en.wikipedia.org/wiki/Making_It_(TV_series)) for", "We are enjoying [Making It](https://en.wikipedia.org/wiki/Making_It_(TV_series)) for")
L(76, "that my [microblog](https://www.thingelstad.com) and", "that [my microblog](https://www.thingelstad.com) and")
L(76, "while my [blog](https://www.thingelstad.com) is", "while [my blog](https://www.thingelstad.com) is")
L(82, "[AWS re:Invent house band playing Blackbird](", "AWS re:Invent house band playing [Blackbird](")
L(84, "I’m a [huge fan of Glengarry Glen Ross](https://en.wikipedia.org/wiki/Glengarry_Glen_Ross_(film)) .", "I’m a huge fan of [Glengarry Glen Ross](https://en.wikipedia.org/wiki/Glengarry_Glen_Ross_(film)).")
L(84, "It [turned me on to David Mamet](https://en.wikipedia.org/wiki/David_Mamet) [and his amazing dialogue](https://en.wikipedia.org/wiki/David_Mamet#) .",
      "It turned me on to [David Mamet](https://en.wikipedia.org/wiki/David_Mamet) and his [amazing dialogue](https://en.wikipedia.org/wiki/David_Mamet#).")
L(89, "[These are handy](mailto:", "These are [handy](mailto:")
L(98, "or [as everyone there calls it, Footy](https://en.wikipedia.org/wiki/Australian_rules_football) .", "or as everyone there calls it, [Footy](https://en.wikipedia.org/wiki/Australian_rules_football).")
L(98, "as [we entered the Melbourne Cricket Grounds](https://en.wikipedia.org/wiki/Melbourne_Cricket_Ground) .", "as we entered the [Melbourne Cricket Grounds](https://en.wikipedia.org/wiki/Melbourne_Cricket_Ground).")
L(98, "and [this Richmond v Carlton game](", "and this [Richmond v Carlton game](")
L(103, "a [number of remembrances of Bill Campbell](https://en.wikipedia.org/wiki/William_Campbell_(business_executive)) and [this review of Trillion Dollar Coach](https://www.trilliondollarcoach.com) has",
       "a number of remembrances of [Bill Campbell](https://en.wikipedia.org/wiki/William_Campbell_(business_executive)) and this review of [Trillion Dollar Coach](https://www.trilliondollarcoach.com) has")
L(118, "[this article to Remove Richard Stallman](", "this article to [Remove Richard Stallman](")
L(118, "[Four days later an Appendix A](", "Four days later an [Appendix A](")
L(118, "That [same day Stallman resigned from MIT](", "That same day [Stallman resigned from MIT](")
L(118, "(https://www.fsf.org/news/richard-m-stallman-resigns) . VICE [has a writeup on this all](", "(https://www.fsf.org/news/richard-m-stallman-resigns). [VICE has a writeup on this all](")
L(118, "-comments) , [but this piece from Steven Levy](https://www.stevenlevy.com) , who wrote [one of my favorite books, Hackers](https://www.stevenlevy.com/index.php/books/hackers) , that",
       "-comments), but this piece from [Steven Levy](https://www.stevenlevy.com), who wrote one of my favorite books, [Hackers](https://www.stevenlevy.com/index.php/books/hackers), that")
L(121, "[I was at the premier](", "I [was at the premier](")
L(124, "to [the former Benevolent Dictator for Life](https://en.wikipedia.org/wiki/Benevolent_dictator_for_life) [(BDFL) of Python, Guido van Rossum](https://en.wikipedia.org/wiki/Guido_van_Rossum) , as",
       "to the former [Benevolent Dictator for Life](https://en.wikipedia.org/wiki/Benevolent_dictator_for_life) (BDFL) of Python, [Guido van Rossum](https://en.wikipedia.org/wiki/Guido_van_Rossum), as")

# --- A: bare App Store / Amazon line above the same link as a title --------------
BARE = re.compile(r"(?m)^(https?://\S*(?:apple\.com|amazon\.com)\S*)\n\n(### \[[^\n]*\]\(\1\)|[^\n\[]+ \(\))$")
A_LINKED, A_PAREN = 33, 4
ed("collapse-empty-link", 58, "Collapse: How Societies Choose to Fail or Succeed: Revised Edition ()\n", "Collapse: How Societies Choose to Fail or Succeed: Revised Edition\n")

# --- B: dead blog permalinks: relink the post's live URL, or unlink if deleted ---
H = "https://www.thingelstad.com"
MOVED = {  # (issue, dead path) -> live path; each checked by hand against the post text
    **{(39, f"/2018/01/27/{s}.html"): "/2018/01/27/074734.html" for s in
       ["winter-kubb-at", "winter-kubb-basecamp", "kubbchucks-went-in", "excited-to-head", "warming-up-for", "kubb-on-frozen", "kubbchucks-at-our", "eric-goplin-kicking"]},
    (39, "/2018/01/27/ticket-to-ride.html"): "/2018/01/27/183307.html",
    (39, "/2018/01/27/i-win.html"): "/2018/01/27/183307.html",
    (41, "/2018/02/12/now-i-sort.html"): "/2018/02/12/we-got-tyler.html",
    (23, "/2017/10/07/mn-ufc-mn.html"): "/2017/10/07/211407.html",
    (294, "/2006/10/14/holiday-minnedemo.html"): "/2006/10/13/holiday-minnedemo.html",   # live a day earlier: UTC date
    (105, "/2019/05/09/133747.html"): "/2019/05/09/080643.html",
    (105, "/2019/05/09/sps-tech-jam.html"): "/2019/05/09/080643.html",
    (105, "/2019/05/04/minnesota-united-v.html"): "/2019/05/04/191509.html",
    (108, "/2019/05/25/beautiful-game-mnufc.html"): "/2019/05/25/minnesota-united-v.html",
    (108, "/2019/04/03/full-fanboy-mode.html"): "/2019/04/03/104013.html",
    (125, "/2019/11/03/152728.html"): "/2019/11/03/160928.html",
    (128, "/2019/11/12/john-sweeney-gave.html"): "/2019/11/12/growth-summit.html",
    (149, "/2019/04/17/the-minnesota-aspirations.html"): "/2019/04/17/minnesota-aspirations-in.html",
    (252, "/2023/03/20/we-finished-our.html"): "/2023/03/20/we-finished-our-weekend-in.html",
    (267, "/2005/02/21/roadsignmathcom-launched.html"): "/2005/02/21/road-sign-math-launched.html",
    (279, "/2018/10/01/picked-up-my.html"): "/2018/10/01/picked-up-my-tesla-model.html",
    (280, "/2020/03/08/celebrating-international-womens.html"): "/2020/03/08/celebrating-international-womens-day-iwd.html",
    (285, "/2012/04/21/walking-high-line.html"): "/2012/04/21/walking-the-high-line-awesome.html",
    (285, "/2023/04/21/gorgeous-day-to.html"): "/2023/04/21/gorgeous-day-to-enjoy-a.html",
}
DEAD = json.load(open(Path(__file__).with_name("dead-permalinks.json")))   # {issue: [paths]}, the 54 found 2026-10-07
GONE = {(int(n), p) for n, ps in DEAD.items() for p in ps} - set(MOVED)
assert set(MOVED) <= {(int(n), p) for n, ps in DEAD.items() for p in ps}
for (n, p), q in MOVED.items():
    ed("relink", n, f"(http://www.thingelstad.com{p})", f"({H}{q})") if f"(http://www.thingelstad.com{p})" in Path(f"data/issues/{n}/archive.md").read_text() else ed("relink", n, f"({H}{p})", f"({H}{q})")

# --- C: the empty Supporting Membership heading; its two rules become one --------
for n in [315, 316, 317, 320, 321, 323, 324, 325, 328, 331, 332, 333, 334, 335, 336, 337, 338]:
    ed("membership-heading", n, "\n---\n\n## Supporting Membership\n\n---\n", "\n---\n")

# --- D: Buttondown buttons -> markdown links -------------------------------------
BTN = re.compile(r'<buttondown-button align="center" href="([^"]+)">([^<]+)</buttondown-button>')

def split(t):
    i = t.index("\n---\n", 3) + 1; return t[:i + 4], t[i + 4:]

issues = sorted(set(E) | {int(n) for n in DEAD} | {338, 339, 340} | {23, 24, 25, 26, 27, 29, 30, 31, 32, 34, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 52, 53, 57, 64, 69, 70, 72, 77})
counts, a_linked, a_paren, changed = defaultdict(int), 0, 0, {}
for n in issues:
    p = Path(f"data/issues/{n}/archive.md"); fm, body = split(p.read_text(encoding="utf-8")); b = body
    for cat, old, new in E.get(n, []):
        k = b.count(old); assert k == 1, f"WT{n} {cat}: {k} matches for {old[:70]!r}"
        b = b.replace(old, new); counts[cat] += 1
    def bare(m):
        global a_linked, a_paren
        if m.group(2).startswith("### "): a_linked += 1; return m.group(2)
        a_paren += 1; return f"[{m.group(2)[:-3]}]({m.group(1)})"
    b = BARE.sub(bare, b)
    for (gn, path) in sorted(GONE):
        if gn != n: continue
        pat = re.compile(r"( \[→\]|\[([^\]]+)\])\(https?://www\.thingelstad\.com" + re.escape(path) + r"\)")
        ms = pat.findall(b); assert len(ms) == 1, f"WT{n} unlink {path}: {len(ms)} matches"
        b = pat.sub(lambda m: "" if m.group(1) == " [→]" else m.group(2), b); counts["unlink"] += 1
    if n in (338, 339, 340):
        k = len(BTN.findall(b)); assert k == 2, (n, k); b = BTN.sub(r"[\2](\1)", b); counts["button"] += k
    if b != body: changed[n] = b
assert (a_linked, a_paren) == (A_LINKED, A_PAREN), (a_linked, a_paren)
counts["bare-line"] = a_linked + a_paren
print(dict(counts), "issues changed:", len(changed))
print(" ".join(str(n) for n in sorted(changed)))
if write:
    for n, b in changed.items():
        p = Path(f"data/issues/{n}/archive.md"); fm, _ = split(p.read_text(encoding="utf-8")); p.write_text(fm + b, encoding="utf-8")
