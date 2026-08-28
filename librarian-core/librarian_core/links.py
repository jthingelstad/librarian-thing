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

The hand-curated excluded-domain list lives beside this module in
``domain_exclusions.py`` — promoted into librarian_core when its previous
home, ``pipeline/content/``, retired.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

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
