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
export const MCP_SERVER_VERSION = '1.4.0';

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
