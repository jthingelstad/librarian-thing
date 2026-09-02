/**
 * Source-scope helpers for the Thingy agent.
 *
 * Thingy answers over independent corpora: the Weekly Thing issue archive
 * (`weekly_thing`), Jamie's 20-year thingelstad.com blog (`blog`), and
 * Another Thing podcast transcripts (`podcast`). Scope is enforced by *which
 * corpus the retrieval scans*, not by a post-filter.
 *
 * Two-source scopes preserve the selected corpus boundary. `all` retrieves
 * candidates from every corpus and reranks the union once.
 *
 * Default is `weekly_thing` so the service `/retrieve` path (wt-builder) is
 * unaffected when it sends no scope.
 */

export const SCOPES = ['weekly_thing', 'blog', 'podcast', 'both', 'weekly_thing_podcast', 'blog_podcast', 'all'];
export const DEFAULT_SCOPE = 'weekly_thing';
export type LibrarianScope = (typeof SCOPES)[number];
export type LibrarianSourceKind = 'weekly_thing' | 'blog' | 'podcast';

function sourceToken(value: unknown): LibrarianSourceKind | '' {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (
    raw === 'weekly_thing' ||
    raw === 'wt' ||
    raw === 'weeklything' ||
    raw === 'issues' ||
    raw === 'archive' ||
    raw === 'newsletter'
  )
    return 'weekly_thing';
  if (raw === 'blog' || raw === 'thingelstad' || raw === 'thingelstad_com') return 'blog';
  if (raw === 'podcast' || raw === 'podcasts' || raw === 'another_thing' || raw === 'anotherthing' || raw === 'another')
    return 'podcast';
  return '';
}

/** Coerce arbitrary input into one of SCOPES, defaulting to weekly_thing. */
export function normalizeScope(value: unknown): LibrarianScope {
  const input = String(value || '')
    .trim()
    .toLowerCase();
  const raw = input.replace(/[\s-]+/g, '_');
  const source = sourceToken(raw);
  if (source) return source;
  if (raw === 'both') return 'both';
  if (raw === 'weekly_thing_podcast' || raw === 'wt_podcast') return 'weekly_thing_podcast';
  if (raw === 'blog_podcast' || raw === 'podcast_blog') return 'blog_podcast';
  if (raw === 'all' || raw === 'everything') return 'all';
  const tokens = input.split(/[,+|]/).map(sourceToken).filter(Boolean);
  const selected = new Set(tokens);
  if (selected.size === 3) return 'all';
  if (selected.has('weekly_thing') && selected.has('blog') && selected.size === 2) return 'both';
  if (selected.has('weekly_thing') && selected.has('podcast') && selected.size === 2) return 'weekly_thing_podcast';
  if (selected.has('blog') && selected.has('podcast') && selected.size === 2) return 'blog_podcast';
  if (selected.size === 1) return Array.from(selected)[0] as LibrarianScope;
  return DEFAULT_SCOPE;
}

/** Corpus kinds a scope scans, in retrieval order (WT first for mixed scopes). */
export function scopeKinds(scope: unknown): LibrarianSourceKind[] {
  const normalized = normalizeScope(scope);
  if (normalized === 'blog') return ['blog'];
  if (normalized === 'podcast') return ['podcast'];
  if (normalized === 'both') return ['weekly_thing', 'blog'];
  if (normalized === 'weekly_thing_podcast') return ['weekly_thing', 'podcast'];
  if (normalized === 'blog_podcast') return ['blog', 'podcast'];
  if (normalized === 'all') return ['weekly_thing', 'blog', 'podcast'];
  return ['weekly_thing'];
}

/**
 * One-line, per-turn system instruction telling the agent which corpus it
 * may speak from. Injected as a system block after the cached static
 * prompt, so it varies per request without busting the prompt cache.
 */
export function scopePromptLine(scope: unknown) {
  switch (normalizeScope(scope)) {
    case 'blog':
      return "Active source scope: **thingelstad.com blog only**. Answer from Jamie's personal blog posts (his 20-year blog), not the Weekly Thing newsletter. Blog sources have no WT issue number — cite them by title and link, not by WT<N>.";
    case 'podcast':
      return "Active source scope: **Another Thing podcast only**. Answer from podcast episode transcripts and show notes, not the Weekly Thing newsletter or Jamie's blog. Podcast sources have no WT issue number — cite them by episode title and link, not by WT<N>.";
    case 'both':
      return 'Active source scope: **Weekly Thing archive + thingelstad.com blog**. Draw on both. Cite Weekly Thing issues as WT<N> and blog posts by title and link. When a source carries `also_in_issues`, the blog post was also featured in those Weekly Thing issue(s) — you may note the cross-reference (e.g. "Jamie also featured this in WT###").';
    case 'weekly_thing_podcast':
      return "Active source scope: **Weekly Thing archive + Another Thing podcast**. Draw on both selected sources, not Jamie's blog. Cite Weekly Thing issues as WT<N>; cite podcast sources by episode title/link.";
    case 'blog_podcast':
      return 'Active source scope: **thingelstad.com blog + Another Thing podcast**. Draw on both selected sources, not the Weekly Thing archive. Cite blog posts by title/link; cite podcast sources by episode title/link. These sources have no WT issue number.';
    case 'all':
      return 'Active source scope: **Weekly Thing archive + thingelstad.com blog + Another Thing podcast**. Draw on all selected sources. Cite Weekly Thing issues as WT<N>; cite blog posts by title/link; cite podcast sources by episode title/link. Blog and podcast sources have no WT issue number.';
    default:
      return "Active source scope: **Weekly Thing archive only**. Answer from Weekly Thing issues and the site/FAQ pages. If the reader explicitly asks about Jamie's personal blog or Another Thing podcast, tell them that source scope is available but not currently selected.";
  }
}
