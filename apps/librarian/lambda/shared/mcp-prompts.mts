/**
 * MCP prompts: the good call sequences, published. The routing knowledge
 * the chat agent carries in agent-system.md reaches MCP clients here - a
 * client that offers prompts shows these as ready-made asks, and each one
 * expands into the tool sequence that answers it well.
 *
 * The text instructs the calling model. It never speaks as Jamie, and it
 * names Jamie rather than using a pronoun.
 */

import { isCalendarDate } from './mcp-resources.mjs';

type PromptArgs = Record<string, string>;

interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  // Returns the problem with the arguments, or '' when they are usable.
  check?: (args: PromptArgs) => string;
  text: (args: PromptArgs) => string;
}

const CITE =
  'Cite every source as a markdown link to its url: [WT351](url) for a Weekly Thing issue, the title for a blog post, the episode for a podcast.';

const PROMPTS: PromptDefinition[] = [
  {
    name: 'thinking_over_time',
    title: "How Jamie's thinking changed",
    description:
      "Trace how Jamie's own view of a topic changed across the archive, in Jamie's words, with dated citations.",
    arguments: [
      { name: 'topic', description: 'The topic, person or product to trace, e.g. "RSS" or "Mastodon".', required: true }
    ],
    text: ({ topic }) =>
      [
        `Trace how Jamie Thingelstad's thinking on "${topic}" changed over time, using the Librarian tools.`,
        '',
        `1. Call archive_lens with topic "${topic}", voice "jamie" and operation "by_year": when Jamie wrote about it in Jamie's own words, and how much each year.`,
        '2. Pick three to five turning points: the first mention, the busiest years, any year the position shifts, and the latest mention. Read each with get_source (pass its id; pass section to read one part whole).',
        `3. Call compare_eras for "${topic}" with an early span as year_a and a recent span as year_b, voice "jamie", to set the early and the recent view side by side.`,
        "4. Write a short, dated account of how the view changed. Quote only Jamie's own words; when a passage is a link Jamie shared rather than Jamie's opinion, say so.",
        '',
        `${CITE} If the lens finds little, say so plainly rather than stretching thin evidence.`
      ].join('\n')
  },
  {
    name: 'year_in_review',
    title: 'A year in review',
    description:
      'A year of the archive: what Jamie published, the themes, what Jamie was into, and the links that mattered.',
    arguments: [{ name: 'year', description: 'Four-digit year, e.g. "2021".', required: true }],
    check: ({ year }) => (/^(19|20)\d{2}$/.test(year) ? '' : 'year must be a four-digit year'),
    text: ({ year }) =>
      [
        `Write a year in review of ${year} from Jamie Thingelstad's archive, using the Librarian tools.`,
        '',
        `1. corpus_stats with year_range [${year}, ${year}]: how much was published where, and the year's distinctive terms and domains.`,
        `2. list_content with year_range [${year}, ${year}] and source_kind "weekly_thing" for the issues; again with source_kind "blog" for the posts.`,
        `3. currently_history for ${year}: what Jamie was reading, watching, playing and building.`,
        `4. top_references for ${year}: the sites Jamie linked to most.`,
        `5. media_search with year ${year} (no query lists them newest first) for a few photos worth showing; view_photo before describing one.`,
        "6. Read two or three of the year's defining issues or posts with get_source.",
        '',
        `Then write the review: the themes, the moments, what Jamie was into, and the links that mattered. ${CITE}`
      ].join('\n')
  },
  {
    name: 'reading_path',
    title: 'A reading path',
    description: 'An ordered reading list through one theme of the archive, with why each piece comes where it does.',
    arguments: [
      { name: 'theme', description: 'The theme, e.g. "personal knowledge management".', required: true },
      { name: 'length', description: 'How many pieces, 3 to 12 (default 6).', required: false }
    ],
    check: ({ length }) =>
      !length || (/^\d+$/.test(length) && Number(length) >= 3 && Number(length) <= 12)
        ? ''
        : 'length must be a whole number from 3 to 12',
    text: ({ theme, length }) =>
      [
        `Build a reading path through "${theme}" in Jamie Thingelstad's archive: ${length || 6} pieces, in the order a newcomer should read them.`,
        '',
        `1. archive_lens with topic "${theme}" and operation "reading_path".`,
        `2. If the path is thin, archive_gems with theme "${theme}", or search_archive for "${theme}", adds candidates.`,
        "3. Use each candidate's skim (description or abstract) to choose, and open the strongest with get_source.",
        '4. Present the path as a numbered list: the title as a markdown link to its url, the date, and one sentence on why it comes at that point. Mix Weekly Thing issues, blog posts and podcast episodes where the archive has them.'
      ].join('\n')
  },
  {
    name: 'this_week_in_past_years',
    title: 'This week in past years',
    description: "What Jamie published this week in past years: the archive's on-this-day, a week wide.",
    arguments: [
      {
        name: 'date',
        description: 'MM-DD or YYYY-MM-DD (default today in America/Chicago).',
        required: false
      }
    ],
    check: ({ date }) => (!date || isCalendarDate(date) ? '' : 'date must be a calendar day as MM-DD or YYYY-MM-DD'),
    text: ({ date }) =>
      [
        `Show what Jamie Thingelstad published this week in past years${date ? ` (around ${date})` : ''}, using the Librarian tools.`,
        '',
        `1. on_this_day with ${date ? `date "${date}" and ` : ''}window_days 3.`,
        '2. For each year with something, pick the one or two most interesting items; read one with get_source when its excerpt is not enough.',
        '3. When an item has a photo, view_photo can show it; embed a chosen photo as [![alt](image_url)](source_url).',
        '4. Present it newest year first: the year, how many years ago, and each item as a markdown link to its url with a line on what it was.'
      ].join('\n')
  },
  {
    name: 'research_brief',
    title: 'Research brief',
    description: 'A brief on a person, product, company or project, from what the archive holds about it.',
    arguments: [
      {
        name: 'subject',
        description: 'The person, product, company or project, e.g. "Obsidian" or "Ben Thompson".',
        required: true
      }
    ],
    text: ({ subject }) =>
      [
        `Write a research brief on "${subject}" from Jamie Thingelstad's archive, using the Librarian tools.`,
        '',
        `1. archive_lens with topic "${subject}" and operation "first_last": when it first and last appears, and where.`,
        `2. archive_lens with topic "${subject}", operation "timeline" and voice "jamie": what Jamie said about it, as opposed to what Jamie linked.`,
        `3. find_links with topic "${subject}" (or domain, when the subject has a website): the links Jamie shared about it.`,
        `4. quote_search for "${subject}" when a claim hinges on an exact mention.`,
        '5. Read the two or three most substantial sources with get_source.',
        '',
        `Write the brief: what ${subject} is according to the archive (not general knowledge), when and how Jamie came to it, Jamie's view in Jamie's own words, the best links shared, and open questions. ${CITE}`
      ].join('\n')
  }
];

export function promptList() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({
    name,
    title,
    description,
    arguments: args
  }));
}

export class PromptArgumentError extends Error {}

/** prompts/get: the expanded prompt, or null for an unknown name. */
export function getPrompt(name: string, rawArgs: unknown) {
  const prompt = PROMPTS.find((entry) => entry.name === name);
  if (!prompt) return null;
  const given = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as PromptArgs) : {};
  const args: PromptArgs = {};
  for (const argument of prompt.arguments) {
    const value = String(given[argument.name] ?? '').trim();
    if (argument.required && !value) throw new PromptArgumentError(`${argument.name} is required`);
    if (value) args[argument.name] = value.slice(0, 200);
  }
  const unknown = Object.keys(given).filter((key) => !prompt.arguments.some((argument) => argument.name === key));
  if (unknown.length) throw new PromptArgumentError(`unknown argument "${unknown[0]}"`);
  const problem = prompt.check?.(args) || '';
  if (problem) throw new PromptArgumentError(problem);
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }]
  };
}
