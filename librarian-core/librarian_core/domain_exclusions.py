"""Domains to exclude from the linked domains list on issue pages."""

EXCLUDED_DOMAINS = {
    # Newsletter's own domains
    "weekly.thingelstad.com",
    "thingelstad.com",
    "www.thingelstad.com",
    # Buttondown
    "buttondown.com",
    "buttondown.email",
    # Image CDNs and hosting
    "imgur.com",
    "i.imgur.com",
    "cloudinary.com",
    "res.cloudinary.com",
    "images.unsplash.com",
    "unsplash.com",
    # URL shorteners
    "t.co",
    "bit.ly",
    "tinyurl.com",
    "ow.ly",
    "buff.ly",
    "goo.gl",
    # Generic utility / CDN
    "fonts.google.com",
    "fonts.googleapis.com",
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "gravatar.com",
    # Email / unsubscribe
    "email.mg.buttondown.email",
    "manage.kmail-lists.com",
    # Common embed/media hosts (not interesting as "linked domains")
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "open.spotify.com",
    "player.vimeo.com",
    # Reference / encyclopedic (inline references, not curated links)
    "en.wikipedia.org",
    "wikipedia.org",
    "en.m.wikipedia.org",
    # Social media (too generic to be interesting in domain lists)
    "twitter.com",
    "x.com",
    "facebook.com",
    "www.facebook.com",
    "instagram.com",
    "www.instagram.com",
    "linkedin.com",
    "www.linkedin.com",
}


def is_excluded(domain: str) -> bool:
    """Check if a domain should be excluded from the linked domains list."""
    domain = domain.lower().strip()
    if domain in EXCLUDED_DOMAINS:
        return True
    # Exclude subdomains of excluded domains
    for excluded in EXCLUDED_DOMAINS:
        if domain.endswith("." + excluded):
            return True
    return False
