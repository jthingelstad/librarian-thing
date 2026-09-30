// How a source names itself to callers outside the chat loop: an absolute
// URL, a citation label, and an honest source_kind. The corpus keeps Weekly
// Thing URLs site-relative (/archive/351/, /about/) because the weekly site
// renders them; every consumer outside that site had to absolutise them
// itself (AT Builder did, MCP clients could not). Blog and podcast URLs are
// already absolute.

export const WEEKLY_BASE_URL = 'https://weekly.thingelstad.com';

export function absoluteSourceUrl(url: unknown): string | undefined {
  if (url == null || url === '') return undefined;
  const value = String(url);
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${WEEKLY_BASE_URL}${value}`;
  return value;
}

// WT chunks are stored with source_kind "chunk" (a corpus-build term); the
// public vocabulary is weekly_thing / blog / podcast, plus site_page and faq
// for the Weekly Thing's own about and FAQ pages.
export function publicSourceKind(source: { source_kind?: unknown; issue_number?: unknown; url?: unknown }): string {
  const kind = String(source.source_kind || '');
  if (kind === 'chunk' || kind === 'issue' || kind === '') {
    if (source.issue_number != null && source.issue_number !== '') return 'weekly_thing';
    return kind || (source.url ? 'external' : 'weekly_thing');
  }
  return kind;
}

function clip(value: string, max: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The label a writer cites: WT351 for an issue, AT3 for an Another Thing
// episode, the title for a blog post (a dated "Blog post" for an untitled
// micropost), and the page name for the Weekly Thing's site pages.
export function sourceLabel(source: {
  source_kind?: unknown;
  issue_number?: unknown;
  episode_number?: unknown;
  subject?: unknown;
  title?: unknown;
  publish_date?: unknown;
  url?: unknown;
}): string {
  const kind = publicSourceKind(source);
  if (kind === 'weekly_thing' && source.issue_number != null && source.issue_number !== '') {
    return `WT${source.issue_number}`;
  }
  if (kind === 'podcast' && source.episode_number != null && source.episode_number !== '') {
    return `AT${source.episode_number}`;
  }
  const title = clip(String(source.title || source.subject || ''), 90);
  if (title) return title;
  const date = String(source.publish_date || '').slice(0, 10);
  if (kind === 'blog') return date ? `Blog post, ${date}` : 'Blog post';
  if (kind === 'podcast') return date ? `Another Thing, ${date}` : 'Another Thing';
  return kind === 'faq' ? 'Weekly Thing FAQ' : 'Weekly Thing';
}
