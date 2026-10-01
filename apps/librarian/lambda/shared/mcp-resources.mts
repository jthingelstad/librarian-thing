/**
 * MCP resources: the archive as addressable things a client can attach as
 * context without a tool round-trip ("attach WT351"). Every read is served
 * by the same registry tools, so a resource and a tool call can never
 * disagree; the MCP layer spends quota and the runtime audits each read as
 * resource:<kind>.
 *
 *   librarian://wt/{n}             one Weekly Thing issue, as markdown
 *   librarian://blog/{id}          one blog post by micro.blog id, as markdown
 *   librarian://topic/{slug}       a topic's catalogue card and timeline
 *   librarian://year/{yyyy}        what the archive holds for one year
 *   librarian://on-this-day/{mm-dd} that calendar day in past years
 *
 * resources/list offers the newest issues. The list changes weekly and a
 * stateless server cannot notify, so neither listChanged nor subscribe is
 * declared; clients re-list on connect.
 */
import { siteTopicSlug } from './archive-tools.mjs';
import { absoluteSourceUrl } from './source-identity.mjs';

type JsonRecord = Record<string, unknown>;

export type ResourceKind = 'wt' | 'blog' | 'topic' | 'year' | 'on-this-day';

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'librarian://wt/{n}',
    name: 'weekly-thing-issue',
    title: 'Weekly Thing issue',
    description: 'One Weekly Thing issue as markdown, e.g. librarian://wt/351.',
    mimeType: 'text/markdown'
  },
  {
    uriTemplate: 'librarian://blog/{id}',
    name: 'blog-post',
    title: 'Blog post',
    description: 'One thingelstad.com blog post or micropost by its micro.blog id, e.g. librarian://blog/6034145.',
    mimeType: 'text/markdown'
  },
  {
    uriTemplate: 'librarian://topic/{slug}',
    name: 'topic',
    title: 'Topic',
    description:
      'A topic by the slug of its page (librarian://topic/apple) or cluster (librarian://topic/ai-and-agents): its catalogue card and its timeline across the archive.',
    mimeType: 'application/json'
  },
  {
    uriTemplate: 'librarian://year/{yyyy}',
    name: 'year',
    title: 'A year of the archive',
    description: "What the archive holds for one year: counts by source, the year's distinctive terms and domains.",
    mimeType: 'application/json'
  },
  {
    uriTemplate: 'librarian://on-this-day/{mm-dd}',
    name: 'on-this-day',
    title: 'On this day',
    description: 'What Jamie published on one calendar day in past years, e.g. librarian://on-this-day/09-29.',
    mimeType: 'application/json'
  }
];

export interface ParsedResource {
  uri: string;
  kind: ResourceKind;
  value: string;
}

const PATTERNS: Array<[ResourceKind, RegExp]> = [
  ['wt', /^(\d{1,4}(?:-[a-z]+)?)$/],
  ['blog', /^(\d{1,12})$/],
  ['topic', /^([a-z0-9]+(?:-[a-z0-9]+)*)$/],
  ['year', /^((?:19|20)\d{2})$/],
  ['on-this-day', /^((?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/]
];

/** MM-DD (02-29 included) or YYYY-MM-DD that is a day on the calendar. */
export function isCalendarDate(value: unknown) {
  const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  // Without a year, a leap year: February 29 is a day some years have.
  const year = match[1] ? Number(match[1]) : 2024;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A librarian:// URI, or null when it names nothing this server serves. */
export function parseResourceUri(uri: unknown): ParsedResource | null {
  const match = String(uri || '').match(/^librarian:\/\/([a-z-]+)\/([^/?#]+)\/?$/);
  if (!match) return null;
  const pattern = PATTERNS.find(([kind]) => kind === match[1]);
  let decoded = '';
  try {
    decoded = decodeURIComponent(match[2]).toLowerCase();
  } catch {
    // Malformed percent-encoding (librarian://wt/%E0) names nothing.
    return null;
  }
  const value = pattern && decoded.match(pattern[1]);
  // 02-30 fits the pattern but is no day (QA F16: it read as an empty day).
  if (value && pattern[0] === 'on-this-day' && !isCalendarDate(value[1])) return null;
  return pattern && value ? { uri: String(uri), kind: pattern[0], value: value[1] } : null;
}

/** One source (a get_source result) as a markdown document. */
// 2537 seconds reads 42:17; an hour or more reads 1:02:05.
function clockTime(seconds: number) {
  const whole = Math.round(seconds);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const pad = (value: number) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The audio edition of an issue (an episode's own audio too), with its length.
function listenLine(source: JsonRecord) {
  const audio = String(source.audio_url || '');
  if (!audio) return '';
  const seconds = Number(source.audio_duration_seconds);
  const chapters = Array.isArray(source.audio_chapters) ? source.audio_chapters.length : 0;
  const details = [
    Number.isFinite(seconds) && seconds > 0 ? clockTime(seconds) : '',
    chapters ? `${chapters} chapters` : ''
  ].filter(Boolean);
  return `- Listen: ${audio}${details.length ? ` (${details.join(', ')})` : ''}`;
}

export function sourceMarkdown(source: JsonRecord, truncated: JsonRecord = {}) {
  const title = String(source.subject || source.title || source.id || 'Untitled');
  const url = absoluteSourceUrl(source.url);
  const facts = [
    source.id ? `- id: ${source.id}` : '',
    source.publish_date ? `- Published: ${String(source.publish_date).slice(0, 10)}` : '',
    url ? `- URL: ${url}` : '',
    listenLine(source)
  ].filter(Boolean);
  const skim = String(source.description || source.abstract || '').trim();
  const body = String(source.body || '').trim();
  const cut = Array.isArray(truncated.clipped) && truncated.clipped.includes('source.body');
  const note = cut
    ? `\n\n_The body was cut to fit; get_source with id ${String(source.id)}${truncated.next_offset ? ` and offset ${String(truncated.next_offset)}` : ''} reads the rest._`
    : '';
  return [`# ${title}`, facts.join('\n'), skim ? `> ${skim}` : '', `${body}${note}`].filter(Boolean).join('\n\n');
}

export interface ResourceReader {
  // Runs one registry tool; the runtime audits it under auditAs.
  invoke: (name: string, input: JsonRecord, auditAs: string) => Promise<unknown>;
  // Serialises a tool result under the MCP cap (renderToolCallResult).
  render: (name: string, result: unknown) => { text: string; isError: boolean };
}

export class ResourceNotFound extends Error {}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// The whole source: format text (the links the markdown never shows ate
// the body's room, QA F9), read page by page with get_source's offset.
const RESOURCE_MAX_PAGES = 8;

async function readSource(resource: ParsedResource, id: string, reader: ResourceReader) {
  const auditAs = `resource:${resource.kind}`;
  let result = record(await reader.invoke('get_source', { id, format: 'text' }, auditAs));
  if (result.error || !result.source) throw new ResourceNotFound(`No source at ${resource.uri}`);
  const source = { ...record(result.source) };
  let body = String(source.body || '');
  for (let page = 1; page < RESOURCE_MAX_PAGES; page += 1) {
    const offset = Number(record(result.truncated).next_offset) || 0;
    if (!offset) break;
    result = record(await reader.invoke('get_source', { id, format: 'text', offset }, auditAs));
    if (result.error || !result.source) break;
    body += String(record(result.source).body || '');
  }
  source.body = body;
  return {
    uri: resource.uri,
    mimeType: 'text/markdown',
    text: sourceMarkdown(source, record(result.truncated))
  };
}

async function readTool(resource: ParsedResource, name: string, input: JsonRecord, reader: ResourceReader) {
  const result = await reader.invoke(name, input, `resource:${resource.kind}`);
  const rendered = reader.render(name, result);
  if (rendered.isError) throw new ResourceNotFound(`Nothing at ${resource.uri}`);
  return { uri: resource.uri, mimeType: 'application/json', text: rendered.text };
}

/** resources/read for one parsed URI: the contents entry. */
export async function readResource(resource: ParsedResource, reader: ResourceReader) {
  const auditAs = `resource:${resource.kind}`;
  if (resource.kind === 'wt') return readSource(resource, `wt-${resource.value.replace(/^0+(?=\d)/, '')}`, reader);
  if (resource.kind === 'blog') return readSource(resource, `blog-${resource.value}`, reader);
  if (resource.kind === 'year') {
    const year = Number(resource.value);
    return readTool(resource, 'corpus_stats', { year_range: [year, year] }, reader);
  }
  if (resource.kind === 'on-this-day') return readTool(resource, 'on_this_day', { date: resource.value }, reader);
  // topic: find the card whose page or cluster slug this is, then trace it.
  const words = resource.value.replaceAll('-', ' ');
  const catalogue = record(await reader.invoke('list_topics', { query: words, limit: 100 }, auditAs));
  const cards: JsonRecord[] = [
    ...((catalogue.clusters as JsonRecord[] | undefined) || []).map((card) => ({ kind: 'cluster', ...card })),
    ...((catalogue.topics as JsonRecord[] | undefined) || []).map((card) => ({ kind: 'topic', ...card }))
  ];
  // A page's slug is in its url; a cluster is slugged like a page.
  const card = cards.find(
    (entry) =>
      String(entry.url || '').endsWith(`/topics/${resource.value}/`) ||
      siteTopicSlug(String(entry.name || '')) === resource.value
  );
  if (!card) throw new ResourceNotFound(`No topic at ${resource.uri}; list_topics names them`);
  const lens = record(await reader.invoke('archive_lens', { topic: card.name, limit: 12 }, auditAs));
  const rendered = reader.render('archive_lens', { topic_card: card, ...lens });
  if (rendered.isError) throw new ResourceNotFound(`Nothing at ${resource.uri}`);
  return { uri: resource.uri, mimeType: 'application/json', text: rendered.text };
}

/** resources/list: the newest Weekly Thing issues, as resources. */
export async function listResources(reader: ResourceReader) {
  const latest = record(
    await reader.invoke('latest_content', { source_kind: 'weekly_thing', limit: 12 }, 'resource:list')
  );
  const issues = ((latest.results as JsonRecord[] | undefined) || []).filter((item) => item.issue_number);
  return issues.map((issue) => ({
    uri: `librarian://wt/${issue.issue_number}`,
    name: `WT${issue.issue_number}`,
    title: String(issue.subject || `WT${issue.issue_number}`),
    ...(issue.description ? { description: String(issue.description) } : {}),
    mimeType: 'text/markdown'
  }));
}
