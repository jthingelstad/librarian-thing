// Per-reader precomputed welcome sets (contract 4.10). A new chat must
// open instantly, so the model work happens AFTER each answer ships (the
// stream Lambda refreshes post-done, where the corpus is already warm -
// the eval Lambda can't host this: no CORPUS_BUCKET, 1024MB) or at most
// once inline on a cold miss. The row is furniture, not truth: losing it
// just means one regeneration.
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { logEvent } from './logging.mjs';
import { generateWelcomeSet } from './archive-experience.mjs';
import { retrieve } from './retrieval.mjs';
import { loadUserConversationSummaries } from './conversation-store.mjs';

const WELCOME_SET_TTL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000;

export interface WelcomeSet {
  greeting_lines: string[];
  suggestions: string[];
  day: string;
  generated_at: number;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function parseLines(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry || '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function readReaderWelcomeSet(subscriberHash: string): Promise<WelcomeSet | null> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName || !subscriberHash) return null;
  try {
    const response = await dynamodb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: `welcome#${subscriberHash}` }, sk: { S: 'welcome' } }
      })
    );
    if (!response.Item) return null;
    return {
      greeting_lines: parseLines(response.Item.greeting_lines?.S),
      suggestions: parseLines(response.Item.suggestions?.S),
      day: String(response.Item.day?.S || ''),
      generated_at: Number(response.Item.generated_at?.N || '0')
    };
  } catch (error) {
    logEvent('warning', 'welcome_set_read_failed', {
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
    return null;
  }
}

async function writeReaderWelcomeSet(subscriberHash: string, set: WelcomeSet) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: { S: `welcome#${subscriberHash}` },
        sk: { S: 'welcome' },
        greeting_lines: { S: JSON.stringify(set.greeting_lines) },
        suggestions: { S: JSON.stringify(set.suggestions) },
        day: { S: set.day },
        generated_at: { N: String(set.generated_at) },
        ttl: { N: String(Math.floor(Date.now() / 1000) + WELCOME_SET_TTL_SECONDS) }
      }
    })
  );
}

// A set is servable if it was generated today and actually has content.
export function welcomeSetFresh(set: WelcomeSet | null): set is WelcomeSet {
  return Boolean(set && set.day === utcDay() && (set.greeting_lines.length || set.suggestions.length));
}

// Generate and store a reader's welcome set. minAgeMs throttles the
// post-turn refreshes; force skips the throttle (inline cold miss).
export async function refreshReaderWelcomeSet({
  subscriberHash,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  force = false
}: {
  subscriberHash: string;
  minAgeMs?: number;
  force?: boolean;
}): Promise<WelcomeSet | null> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName || !subscriberHash) return null;
  if (!force) {
    const existing = await readReaderWelcomeSet(subscriberHash);
    if (welcomeSetFresh(existing) && Date.now() - existing.generated_at < minAgeMs) return existing;
  }
  const conversations = await loadUserConversationSummaries({
    dynamodb,
    tableName,
    subscriberHash,
    limit: 8,
    logEvent
  });
  const suggestionQuery =
    conversations
      .slice(0, 3)
      .map((entry: { title?: unknown }) => String(entry.title || '').trim())
      .filter(Boolean)
      .join('; ') || 'memorable stories, ideas, and recurring threads in the archive';
  let grounding: Awaited<ReturnType<typeof retrieve>> = [];
  try {
    grounding = await retrieve(suggestionQuery, 6, {}, { rerank: false });
  } catch (error) {
    logEvent('warning', 'welcome_grounding_failed', {
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
  }
  const generated = await generateWelcomeSet({ conversations, scope: 'all', grounding });
  const set: WelcomeSet = { ...generated, day: utcDay(), generated_at: Date.now() };
  await writeReaderWelcomeSet(subscriberHash, set);
  return set;
}
