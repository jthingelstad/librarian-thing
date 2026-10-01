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

// A thingelstad.com page (About, Lists, Collections, Open Loop ...) rides the
// blog corpus as a blog source with its own id space: page_id, never
// microblog_id (page 71862 and post 71862 are different things). Every key
// and id a blog source gets goes through these two, so a page can never be
// confused with the post that shares its number.
type BlogIdentity = { page_id?: unknown; microblog_id?: unknown; [key: string]: unknown };

function present(value: unknown) {
  return value !== undefined && value !== null && String(value) !== '';
}

// The id a caller passes back: page-<page_id> or blog-<microblog_id>; ''
// when the row names neither.
export function blogSourceId(item: BlogIdentity): string {
  if (present(item.page_id)) return `page-${item.page_id}`;
  if (present(item.microblog_id)) return `blog-${item.microblog_id}`;
  return '';
}

// The identity part of an internal source key: page:<page_id> or the
// microblog_id; '' when the row names neither (callers fall back to url).
export function blogKeyPart(item: BlogIdentity): string {
  if (present(item.page_id)) return `page:${item.page_id}`;
  if (present(item.microblog_id)) return String(item.microblog_id);
  return '';
}

export function hasBlogIdentity(item: BlogIdentity): boolean {
  return present(item.page_id) || present(item.microblog_id);
}
