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
