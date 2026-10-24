import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { errorFields, logEvent } from './logging.mjs';

// The Lambdas' credentials live in one Secrets Manager secret
// (weekly-thing-librarian-runtime, a JSON object of env-style names) instead
// of the function configuration, where they would sit in plaintext for
// anyone who can read it. Jamie keeps the secret by hand; no deploy writes
// it. Each cold start reads the secret once and places
// the values in process.env, so every reader of BUTTONDOWN_API_KEY,
// SESSION_SECRET and the rest keeps working unchanged; the values exist only
// in this process's memory.
//
// Fails closed: without the secret, or with a name missing or blank, the
// handler refuses the request instead of running unkeyed (an empty
// THINGY_WEB_ORIGIN_TOKEN would switch off the origin check, an empty
// SESSION_SECRET would sign sessions with nothing). A failed or incomplete
// read is retried on the next invocation, so a corrected secret recovers on
// its own. Retire a name from RUNTIME_SECRET_KEYS before removing it from
// the secret.

export const RUNTIME_SECRET_KEYS = [
  'BUTTONDOWN_API_KEY',
  'SESSION_SECRET',
  'THINGY_WEB_ORIGIN_TOKEN',
  'FASTMAIL_JMAP_TOKEN',
  'LIBRARIAN_RETRIEVE_SECRET',
  'LIBRARIAN_GOLDEN_RETRIEVE_SECRET',
  'ANTHROPIC_API_KEY',
  'TURNSTILE_SECRET_KEY'
] as const;

type SecretsClient = Pick<SecretsManagerClient, 'send'>;

let client: SecretsClient | null = null;
let loaded: Promise<void> | null = null;

/** Parse the secret's JSON, keeping only the known names with string values. */
export function runtimeSecretValues(secretString: unknown): Record<string, string> {
  const parsed: unknown = JSON.parse(String(secretString || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime secret is not a JSON object');
  }
  const values: Record<string, string> = {};
  for (const key of RUNTIME_SECRET_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

async function load(secretId: string, secrets: SecretsClient) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const values = runtimeSecretValues(response.SecretString);
  // Names only, never values. A name the hand-kept secret lacks or holds
  // blank is logged and refused before any value is placed, so a slip in the
  // console shows up here instead of as a gate quietly switched off (Codex
  // review, #71).
  const keys = Object.keys(values).sort();
  const empty = keys.filter((key) => !values[key]);
  const missing = RUNTIME_SECRET_KEYS.filter((key) => !(key in values)).sort();
  if (empty.length || missing.length) {
    logEvent('error', 'runtime_secrets_incomplete', { keys, empty, missing });
    throw new Error(
      `runtime secret is incomplete (missing: ${missing.join(', ') || 'none'}; empty: ${empty.join(', ') || 'none'})`
    );
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  logEvent('info', 'runtime_secrets_loaded', { keys, empty, missing });
}

/**
 * Make sure the runtime secret is in process.env before a handler runs.
 * A no-op when LIBRARIAN_RUNTIME_SECRET_ID is unset (local runs and tests,
 * which set the variables directly).
 */
export async function loadRuntimeSecrets(secrets?: SecretsClient) {
  const secretId = String(process.env.LIBRARIAN_RUNTIME_SECRET_ID || '').trim();
  if (!secretId) return;
  if (!loaded) {
    const secretsClient = secrets || (client ||= new SecretsManagerClient({}));
    loaded = load(secretId, secretsClient).catch((error: unknown) => {
      loaded = null;
      throw error;
    });
  }
  try {
    await loaded;
  } catch (error) {
    logEvent('error', 'runtime_secrets_load_failed', errorFields(error));
    throw new Error('Runtime credentials are unavailable', { cause: error });
  }
}

/** Test seam: forget the cached load. */
export function resetRuntimeSecretsForTests() {
  client = null;
  loaded = null;
}
