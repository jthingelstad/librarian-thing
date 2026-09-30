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
  ['wt', /^(\d{1,4})$/],
  ['blog', /^(\d{1,12})$/],
  ['topic', /^([a-z0-9]+(?:-[a-z0-9]+)*)$/],
  ['year', /^((?:19|20)\d{2})$/],
  ['on-this-day', /^((?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/]
];

/** A librarian:// URI, or null when it names nothing this server serves. */
export function parseResourceUri(uri: unknown): ParsedResource | null {
  const match = String(uri || '').match(/^librarian:\/\/([a-z-]+)\/([^/?#]+)\/?$/);
  if (!match) return null;
  const pattern = PATTERNS.find(([kind]) => kind === match[1]);
  const value = pattern && decodeURIComponent(match[2]).toLowerCase().match(pattern[1]);
  return pattern && value ? { uri: String(uri), kind: pattern[0], value: value[1] } : null;
}

/** One source (a get_source result) as a markdown document. */
export function sourceMarkdown(source: JsonRecord) {
  const title = String(source.subject || source.title || source.id || 'Untitled');
  const url = absoluteSourceUrl(source.url);
  const facts = [
    source.id ? `- id: ${source.id}` : '',
    source.publish_date ? `- Published: ${String(source.publish_date).slice(0, 10)}` : '',
    url ? `- URL: ${url}` : ''
  ].filter(Boolean);
  const skim = String(source.description || source.abstract || '').trim();
  const body = String(source.body || '').trim();
  const note = source.body_truncated ? `\n\n_${String(source.body_note || 'The body was cut to fit.')}_` : '';
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

async function readSource(resource: ParsedResource, id: string, reader: ResourceReader) {
  const result = record(await reader.invoke('get_source', { id }, `resource:${resource.kind}`));
  if (result.error || !result.source) throw new ResourceNotFound(`No source at ${resource.uri}`);
  return { uri: resource.uri, mimeType: 'text/markdown', text: sourceMarkdown(record(result.source)) };
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
  if (resource.kind === 'wt') return readSource(resource, `wt-${Number(resource.value)}`, reader);
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
