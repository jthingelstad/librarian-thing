"""Editorial link extraction for The Weekly Thing archive bodies.

Used by the corpus build: the era-specific section name variants
(emoji-suffixed MailChimp-era headings like ``Notable Links 📌``), the
H3-link-only rule for Notable, and the bolded-link-only rule for Briefly.
The website-build and workshop callers this once served are retired; the
rules live on because nine years of archive bodies still carry every era.

Surface:
  extract_links(markdown_body) -> {"notable": [...], "briefly": [...], "all_curated": [...]}
  extract_domains(links) -> sorted list of unique non-excluded FQDNs
  count_words(markdown_body) -> int
  markdown_links(text) -> every inline link, image, autolink and bare URL
  unlink(text) / link_label_text(label) -> link markdown as its words

The hand-curated excluded-domain list lives beside this module in
``domain_exclusions.py`` — promoted into librarian_core when its previous
home, ``pipeline/content/``, retired.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass
from urllib.parse import urlparse, urlsplit, urlunsplit

from .domain_exclusions import is_excluded

NOTABLE_SECTIONS = {
    "Notable",
    "Must Read",
    "Featured",
    "Notable Links 📌",
    "Featured Links 🏅",
    "Links 📌",
}
BRIEFLY_SECTIONS = {
    "Briefly",
    "Recommended Links",
    "FYI",
    "Yet More Links 🍞",
}

# The family each era's H2 belongs to, so one filter finds a part of the issue
# across nine years of renames. Keys are normalised (emoji and punctuation
# dropped, lower-cased): "Microposts 🎈", "Status Updates", "Stream" and
# "Journal" are all Journal. The lead link section of each era is Featured
# ("Featured Links 🏅", then "Must Read", then "Featured"); the second is
# Notable. An H2 not listed here is its own family.
SECTION_FAMILIES = {
    "featured": "Featured",
    "featured links": "Featured",
    "must read": "Featured",
    "must watch": "Featured",
    "notable": "Notable",
    "notable links": "Notable",
    "links": "Notable",
    "recommended links": "Notable",
    "recommended": "Notable",
    "briefly": "Briefly",
    "yet more links": "Briefly",
    "breadcrumbs": "Briefly",
    "fyi": "FYI",
    "journal": "Journal",
    "stream": "Journal",
    "status updates": "Journal",
    "status": "Journal",
    "microposts": "Journal",
    "microblog updates": "Journal",
    "blog posts": "Journal",
    "my blog posts": "Journal",
    "blog": "Journal",
    "currently": "Currently",
    "now reading": "Currently",
    "reading": "Currently",
    "photo": "Photo",
    "photog": "Photo",
    "photograph": "Photo",
    "photograph not mine": "Photo",
    "my weekly photo": "Photo",
    "fortune": "Fortune",
    "reply all": "Reply All",
    "replies": "Reply All",
    "straw poll": "Straw Poll",
    "give back": "Give Back",
    "promotion": "Give Back",
    "want to support the weekly thing": "Support",
    "supporting membership": "Support",
    "highlighted ios app": "App",
    "featured app": "App",
    "app": "App",
}
# Issues 39-49 (2018) filed their links under topic H2s instead of one link
# section. Each is Notable. "Photography" is left out: in 145 and 166 it is
# Jamie's photo, not links.
SECTION_FAMILIES.update(
    dict.fromkeys(
        (
            "apps business coffee culture ethics font food funny games health indieweb"
            " interview kubb management media meditation music people privacy product"
            " productivity programming research science security software sports tech"
            " transportation visualization web"
        ).split()
        + ["social media", "self improvement"],
        "Notable",
    )
)


def _family_key(name: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", name.lower()).split())


def section_family(name: str | None) -> str | None:
    """The family of an H2 heading, or None for a heading no era used as a
    section (the H2 is then its own family)."""
    key = _family_key(name or "")
    if key.startswith("yearly thing"):
        return "Yearly Thing"
    return SECTION_FAMILIES.get(key)


def _parse_sections(markdown_body: str) -> list[tuple[str | None, str]]:
    """Split markdown into (section_name, section_text) pairs by H2 heading.
    Pre-first-H2 content gets section_name=None."""
    parts = re.split(r"^(## .+)$", markdown_body, flags=re.MULTILINE)
    sections: list[tuple[str | None, str]] = []
    current_name: str | None = None
    for part in parts:
        h2_match = re.match(r"^## (.+)$", part.strip())
        if h2_match:
            raw = h2_match.group(1).strip()
            current_name = re.sub(r"\[([^\]]*)\]\([^)]+\)", r"\1", raw).strip()
        else:
            sections.append((current_name, part))
    return sections


def _add_link(
    links: list[dict], text: str, url: str, heading_context: str | None, section: str | None
) -> None:
    if not url or url.startswith("#") or url.startswith("mailto:"):
        return
    try:
        parsed = urlparse(url)
        domain = (parsed.hostname or "").lower()
    except Exception:
        return
    if domain:
        links.append(
            {
                "text": text,
                "url": url,
                "domain": domain,
                "heading_context": heading_context,
                "section": section,
            }
        )


def _extract_notable_links(text: str, section_name: str | None) -> list[dict]:
    """Notable: only links in H3 headings are editorial picks. Inline links in
    the commentary below each heading are incidental references."""
    links: list[dict] = []
    seen_urls: set[str] = set()
    for line in text.split("\n"):
        heading_match = re.match(r"^###\s+(.+)", line)
        if not heading_match:
            continue
        heading_text = heading_match.group(1).strip()
        link_match = re.search(r"\[([^\]]*)\]\(([^)]+)\)", heading_text)
        if link_match:
            link_text = link_match.group(1).strip()
            url = link_match.group(2).strip()
            if url not in seen_urls:
                seen_urls.add(url)
                _add_link(links, link_text, url, heading_text, section_name)
    return links


def _extract_briefly_links(text: str, section_name: str | None) -> list[dict]:
    """Briefly: only the bolded link per item is the editorial pick. Falls back
    to H3 heading links for older issues that used that format."""
    links: list[dict] = []
    seen_urls: set[str] = set()
    for line in text.split("\n"):
        if not line.strip():
            continue
        bold_match = re.search(r"\*\*\[([^\]]*)\]\(([^)]+)\)\*\*", line)
        if bold_match:
            link_text = bold_match.group(1).strip()
            url = bold_match.group(2).strip()
            if url not in seen_urls:
                seen_urls.add(url)
                _add_link(links, link_text, url, None, section_name)
            continue
        heading_match = re.match(r"^###\s+(.+)", line)
        if heading_match:
            link_match = re.search(r"\[([^\]]*)\]\(([^)]+)\)", heading_match.group(1))
            if link_match:
                link_text = link_match.group(1).strip()
                url = link_match.group(2).strip()
                if url not in seen_urls:
                    seen_urls.add(url)
                    _add_link(links, link_text, url, None, section_name)
    return links


def _extract_all_links(text: str, section_name: str | None) -> list[dict]:
    """Fallback for very early issues with no H2 section structure — extract
    everything that looks like a link, tagged by whatever H1-6 heading precedes it."""
    links: list[dict] = []
    current_heading: str | None = None
    seen_urls: set[str] = set()
    for line in text.split("\n"):
        heading_match = re.match(r"^#{1,6}\s+(.+)", line)
        if heading_match:
            current_heading = heading_match.group(1).strip()
        for match in re.finditer(r"\[([^\]]*)\]\(([^)]+)\)", line):
            link_text = match.group(1).strip()
            url = match.group(2).strip()
            if url not in seen_urls:
                seen_urls.add(url)
                _add_link(links, link_text, url, current_heading, section_name)
        for match in re.finditer(
            r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
            line,
            re.IGNORECASE,
        ):
            url = match.group(1).strip()
            link_text = re.sub(r"<[^>]+>", "", match.group(2)).strip()
            if url not in seen_urls:
                seen_urls.add(url)
                _add_link(links, link_text, url, current_heading, section_name)
    return links


def extract_links(markdown_body: str) -> dict[str, list[dict]]:
    """Extract curated links from Notable and Briefly sections only.

    Returns {"notable": [...], "briefly": [...], "all_curated": notable + briefly}.
    For issues with no H2 sections (the earliest Tinyletter-era issues), the
    whole body falls into ``notable`` via _extract_all_links.
    """
    sections = _parse_sections(markdown_body)
    notable_links: list[dict] = []
    briefly_links: list[dict] = []
    for section_name, section_text in sections:
        if section_name in NOTABLE_SECTIONS:
            notable_links.extend(_extract_notable_links(section_text, section_name))
        elif section_name in BRIEFLY_SECTIONS:
            briefly_links.extend(_extract_briefly_links(section_text, section_name))
    has_h2 = any(name is not None for name, _ in sections)
    if not has_h2:
        notable_links = _extract_all_links(markdown_body, None)
    return {
        "notable": notable_links,
        "briefly": briefly_links,
        "all_curated": notable_links + briefly_links,
    }


# --- markdown link scanning ------------------------------------------------
#
# One scanner for every link the corpus records (QA 2026-09-30, ingest F6-F8,
# links L3 and L7). The regexes it replaced stopped a label at its first "]"
# and a URL at its first ")", so a linked image recorded the image URL and
# dropped the target, "Elf_(film)" was stored as "Elf_(film",
# "[Python post-Guido [LWN.net]](...)" and "[x]( https://...)" were never
# links, and <autolinks> and bare URLs were not links at all. The scanner
# follows CommonMark where the archive needs it: nested brackets in a label,
# balanced and backslash-escaped parentheses in a destination, whitespace
# after "(", <angle> destinations, titles, and GFM's trailing-punctuation
# rule for bare URLs.


@dataclass(frozen=True)
class MarkdownLink:
    """A link (or image) in markdown text. ``label`` is the raw markdown
    between the brackets ("" for an autolink or a bare URL); ``kind`` is
    ``inline``, ``image``, ``autolink`` or ``bare``."""

    label: str
    url: str
    start: int
    end: int
    kind: str


_BLANK_LINE_RE = re.compile(r"\n[ \t]*\n")
_MD_ESCAPE_RE = re.compile(r"\\([!-/:-@\[-`{-~])")
_AUTOLINK_RE = re.compile(r"<(https?://[^\s<>]+)>", re.I)
_BARE_URL_RE = re.compile(r"https?://[^\s<>\"`]+", re.I)
# Where a bare URL is not a link of its own: inside an HTML comment, an <a>
# element, any tag's attributes, a fenced code block or a code span.
_NOT_BARE_RE = re.compile(
    r"<!--.*?-->|<a\b[^>]*>.*?</a\s*>|<[^>]*>|^[ \t]*(```|~~~).*?^[ \t]*\1|`[^`\n]+`",
    re.I | re.S | re.M,
)
_BARE_TRAILING = ".,:;!?*_~'"


def _label_end(text: str, start: int) -> int | None:
    """Index of the "]" closing the "[" at ``start``: brackets nest,
    backslash escapes do not count, and a label never spans a blank line."""
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return index
        elif char == "\n" and _BLANK_LINE_RE.match(text, index):
            return None
        index += 1
    return None


def _skip_space(text: str, index: int) -> int:
    """Past spaces and tabs and at most one line break."""
    while index < len(text) and text[index] in " \t":
        index += 1
    if index < len(text) and text[index] == "\n":
        index += 1
        while index < len(text) and text[index] in " \t":
            index += 1
    return index


def _destination(text: str, paren: int) -> tuple[str, int] | None:
    """``(url, end)`` for the inline-link destination opening at ``paren``
    (a "("), or None. Parentheses in the URL balance, escaped ones do not
    count, and a title after the URL is skipped. As before, anything else up
    to a ")" on the same line is tolerated after the URL."""
    index = _skip_space(text, paren + 1)
    if index < len(text) and text[index] == "<":
        close = text.find(">", index + 1)
        if close == -1 or "\n" in text[index + 1 : close]:
            return None
        url, index = text[index + 1 : close], close + 1
    else:
        begin, depth = index, 0
        while index < len(text):
            char = text[index]
            if char == "\\" and index + 1 < len(text) and not text[index + 1].isspace():
                index += 2
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
            elif char.isspace() or ord(char) < 0x20:
                break
            index += 1
        url = text[begin:index]
        if url.startswith("["):
            # "[x]([y](url))": a label pasted where the URL goes; the inner
            # link is the link.
            return None
    after = _skip_space(text, index)
    if after < len(text) and text[after] == ")":
        return url, after + 1
    if after < len(text) and text[after] in "\"'(":
        closer = ")" if text[after] == "(" else text[after]
        close = text.find(closer, after + 1)
        if close != -1:
            end = _skip_space(text, close + 1)
            if end < len(text) and text[end] == ")":
                return url, end + 1
    line_end = text.find("\n", index)
    close = text.find(")", index)
    if close != -1 and (line_end == -1 or close < line_end) and "[" not in text[index:close]:
        return url, close + 1
    return None


def _clean_destination(url: str) -> str:
    url = _MD_ESCAPE_RE.sub(r"\1", url.strip()).replace("&amp;", "&")
    # "[x]((https://...))": the doubled parentheses are not the URL's.
    while url.startswith("(") and url.endswith(")"):
        url = url[1:-1].strip()
    return url


def _trim_bare_url(url: str) -> str:
    """GFM's rule: trailing punctuation is not part of a bare URL, nor is a
    closing parenthesis or bracket that has no opener inside it."""
    while url:
        last = url[-1]
        if last in _BARE_TRAILING:
            url = url[:-1]
        elif last == ")" and url.count(")") > url.count("("):
            url = url[:-1]
        elif last == "]" and url.count("]") > url.count("["):
            url = url[:-1]
        else:
            break
    return url


def markdown_links(text: str) -> list[MarkdownLink]:
    """Every inline link, image, autolink and bare URL in ``text``, in
    order. A linked image ``[![alt](img)](target)`` is an ``inline`` link to
    the target whose label holds an ``image`` of img. A bare URL inside a
    link, an image, a tag, an <a> element, a comment or code is not a link
    of its own."""
    found: list[MarkdownLink] = []
    index = 0
    while (index := text.find("[", index)) != -1:
        if index and text[index - 1] == "\\":
            index += 1
            continue
        close = _label_end(text, index)
        if close is None or not text.startswith("(", close + 1):
            index += 1
            continue
        destination = _destination(text, close + 1)
        url = _clean_destination(destination[0]) if destination else ""
        if not url:
            index += 1
            continue
        image = bool(index) and text[index - 1] == "!"
        label = text[index + 1 : close]
        start = index - 1 if image else index
        found.append(
            MarkdownLink(label, url, start, destination[1], "image" if image else "inline")
        )
        # The image inside a linked image's label is media, and a bare URL
        # inside any label is part of the link.
        for inner in markdown_links(label):
            if inner.kind == "image":
                offset = index + 1
                found.append(
                    MarkdownLink(
                        inner.label, inner.url, inner.start + offset, inner.end + offset, "image"
                    )
                )
        index = destination[1]
    covered = [(link.start, link.end) for link in found]
    for match in _AUTOLINK_RE.finditer(text):
        if not any(left <= match.start() < right for left, right in covered):
            found.append(MarkdownLink("", match.group(1), *match.span(), "autolink"))
    covered = [(link.start, link.end) for link in found]
    covered += [match.span() for match in _NOT_BARE_RE.finditer(text)]
    covered.sort()
    starts = [left for left, _ in covered]
    for match in _BARE_URL_RE.finditer(text):
        position = bisect.bisect_right(starts, match.start()) - 1
        if any(
            left <= match.start() < right
            for left, right in covered[max(position - 50, 0) : position + 1]
        ):
            continue
        if match.start() and text[match.start() - 1] in "=\"'":
            continue
        url = _trim_bare_url(match.group(0))
        if "://" in url and url.split("://", 1)[1]:
            found.append(MarkdownLink("", url, match.start(), match.start() + len(url), "bare"))
    found.sort(key=lambda link: link.start)
    return found


def unlink(text: str) -> str:
    """``text`` with each markdown link and image replaced by its label (an
    image's label is its alt text), nested ones too; nothing else changes."""
    out, cursor = [], 0
    for link in markdown_links(text):
        if link.kind not in {"inline", "image"} or link.start < cursor:
            continue
        out.append(text[cursor : link.start])
        out.append(unlink(link.label))
        cursor = link.end
    out.append(text[cursor:])
    return "".join(out)


def link_label_text(label: str) -> str:
    """A link label as plain words: images become their alt text and nested
    links their own label, so "[![Banff](big.jpg)](large.jpg)" reads "Banff".
    Emphasis and code marks go, as ``corpus.plain_text`` drops them."""
    text = unlink(label)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"[*_>~]+", "", text)
    return " ".join(text.split())


# --- malformed URLs --------------------------------------------------------
#
# Typos in the source that gave links a wrong host (QA 2026-09-30, links L6):
# 29 blog links "https://https://www.thingelstad.com/candles/" (domain
# "https"), "ttps://blog.coinbase.com/...", "https://www.hwardmiles.com."
# (a host of its own, "www.hwardmiles.com."), and "http://carcassonne:///f/..."
# (the Carcassonne app's friend link typed after "http://").

_DOUBLED_SCHEME_RE = re.compile(r"^(?:https?:/+)+(?=https?:/)", re.I)
_CLIPPED_SCHEME_RE = re.compile(r"^(ttps?)://", re.I)
_HOST_TRAILING_DOT_RE = re.compile(r"\.+(?=(?::\d*)?$)")


def repair_url(url: str) -> str:
    """``url`` with the typos that give it a wrong host fixed: a doubled
    scheme, a scheme missing its "h", dots after the host name. Any other
    URL comes back as it was (stripped)."""
    url = _DOUBLED_SCHEME_RE.sub("", url.strip())
    url = _CLIPPED_SCHEME_RE.sub(lambda match: f"h{match.group(1)}://", url)
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
    except ValueError:
        return url
    if host.endswith("."):
        url = urlunsplit(parts._replace(netloc=_HOST_TRAILING_DOT_RE.sub("", parts.netloc)))
    return url


def web_domain(url: str) -> str:
    """The link's domain, or "" when it has no web host: no host at all, or
    a host with no dot that is not localhost ("http://carcassonne:///f/1")."""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    if "." not in host and ":" not in host and host != "localhost":
        return ""
    return host


def extract_domains(links: list[dict]) -> list[str]:
    """Sorted unique non-excluded FQDNs from a list of link dicts."""
    domains = set()
    for link in links:
        domain = link.get("domain", "")
        if domain and not is_excluded(domain):
            domains.add(domain)
    return sorted(domains)


def count_words(markdown_body: str) -> int:
    """Word count after stripping HTML, markdown image syntax, URLs, Buttondown
    template tags, and HTML comments. Used in archive front matter and stats."""
    text = re.sub(r"<[^>]+>", " ", markdown_body)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"\{\{[^}]*\}\}", " ", text)
    text = re.sub(r"\{%[^%]*%\}", " ", text)
    text = re.sub(r"<!--.*?-->", " ", text)
    return len(text.split())
