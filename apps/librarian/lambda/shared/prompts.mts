import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const cache = new Map<string, string>();

interface AgentUserPromptValues {
  conversation_context?: unknown;
  reader_context?: unknown;
  question?: unknown;
}

export function promptPath(name: string) {
  return path.join(PROMPTS_DIR, name);
}

export function loadPrompt(name: string): string {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(promptPath(name), 'utf8').trim());
  }
  return cache.get(name) ?? '';
}

// Deterministic fingerprint of the packaged prompt set. Computed once per
// cold start from the prompt files themselves (sorted by name), so any
// prompt edit - which requires a redeploy - changes the fingerprint and
// recorded turns can be compared across prompt versions.
let fingerprint = '';
export function promptFingerprint(): string {
  if (!fingerprint) {
    const hash = crypto.createHash('sha256');
    try {
      for (const name of fs.readdirSync(PROMPTS_DIR).sort()) {
        hash.update(name);
        hash.update('\u0000');
        hash.update(fs.readFileSync(path.join(PROMPTS_DIR, name)));
      }
      fingerprint = hash.digest('hex').slice(0, 12);
    } catch {
      fingerprint = 'unavailable';
    }
  }
  return fingerprint;
}

// The tool-surface cache key, also stamped onto tool responses
// (belt-and-braces: listChanged depends on client behavior we don't
// control; a version on the payload lets an agent detect a stale cached
// tools/list from any response). The minor is bumped by hand when tool
// behaviour or the tool list changes outside tool-specs.json (which the
// fingerprint covers) - clients cache tools/list on this value.
// 1.2.0: view_photo joined the surface.
// 1.3.0: on_this_day; errors carry isError + code; arguments validated
//        before quota; results fit the cap as valid JSON; lens ids resolve.
// 1.4.0: section families (section "Journal" finds every era's Journal),
//        search_archive voice / section_family / content_kind / source_kind,
//        find_links url and link_role over commentary and Journal links;
//        link rankings and counts are headline picks.
// 1.5.0: list_topics and compare_eras published; the skim (description,
//        abstract, key_points) on source records and search results;
//        similar_issues; topic and category filters; voice on quote_search,
//        the claim check and the lenses; media_search issue_number; yearly terms
//        scored against the whole corpus.
// 1.5.1: topic labels match only when named whole (archive_lens, list_content,
//        gems); list_content reads every chunk; domain filters match the
//        domain and its subdomains; find_links sorts newest first (sort) and
//        says what it left out; get_source sends the body once
//        (section_texts retired, body_truncated); on_this_day windowed
//        default of 2 a year; source_neighborhood cross_source_count;
//        five yearly terms; weekly skims carry the description, not the
//        greeting; argument descriptions; no pronouns for Jamie.
// 1.5.2: corpus_stats yearly_signals: limit years (newest first, with a
//        note), three domains and one sample a year, the sample naming its
//        source id.
// 1.6.0: resources (librarian://wt, blog, topic, year, on-this-day) and five
//        prompts; readOnlyHint/openWorldHint on every tool; schemas declare
//        additionalProperties false; urls go out absolute; list_topics
//        matches a name spelled as a slug.
// 2.0.0 (breaking): get_source and source_neighborhood take id only, and
//        get_source a format (outline, text, full); search_archive groups
//        passages under their source; entity_lens folded into archive_lens
//        (aliases, aliases_checked); claim_check became find_evidence
//        (claims, evidence only, no verdict); year is shorthand for
//        year_range everywhere, and year_range replaces year_start/year_end;
//        what a result leaves out is in one truncated block
//        ({omitted, clipped, hint}), never inline markers or *_omitted and
//        *_note keys; counts are [{key, count}] lists and totals total_count;
//        every tool declares an outputSchema and a successful call carries
//        structuredContent; a result too large to fit is an error.
export const MCP_SERVER_VERSION = '2.3.0';

export function serverVersion() {
  return `${MCP_SERVER_VERSION}+tools.${promptFingerprint()}`;
}

// Human display titles for tools - shown by MCP clients (Claude renders
// the title, not the identifier) and in Thingy's own status line. The
// snake_case names stay stable: they are load-bearing identifiers across
// prompts, evals, fixtures, and recorded conversation history.
export function toolTitle(name: unknown): string {
  const titles = JSON.parse(loadPrompt('tool-titles.json')) as Record<string, string>;
  return titles[String(name || '')] || String(name || '').replaceAll('_', ' ');
}

export function loadToolSpecs(): unknown[] {
  return JSON.parse(loadPrompt('tool-specs.json')) as unknown[];
}

export function renderTemplate(text: unknown, values: Record<string, unknown> = {}) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(values[key] ?? ''));
}

export function answerStyle() {
  return loadPrompt('answer-style.md').replace(/\s+/g, ' ');
}

export function agentSystemPrompt() {
  return renderTemplate(loadPrompt('agent-system.md'), { answer_style: answerStyle() });
}

export function agentUserPrompt({ conversation_context, reader_context, question }: AgentUserPromptValues = {}) {
  return renderTemplate(loadPrompt('agent-user.md'), {
    conversation_context,
    reader_context,
    question
  });
}

export function premiumThankYouSystemPrompt() {
  return loadPrompt('premium-thank-you.md');
}
