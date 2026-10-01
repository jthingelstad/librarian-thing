import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { errorFields, logEvent } from './logging.mjs';

// The Lambdas' credentials live in one Secrets Manager secret
// (weekly-thing-librarian-runtime, a JSON object of env-style names) instead
// of the function configuration, where they would sit in plaintext for
// anyone who can read it. Each cold start reads the secret once and places
// the values in process.env, so every reader of BUTTONDOWN_API_KEY,
// SESSION_SECRET and the rest keeps working unchanged; the values exist only
// in this process's memory.
//
// Fails closed: without the secret the handler refuses the request instead
// of running unkeyed (an empty THINGY_WEB_ORIGIN_TOKEN, for one, would switch
// off the origin check). A failed read is retried on the next invocation.

export const RUNTIME_SECRET_KEYS = [
  'BUTTONDOWN_API_KEY',
  'SESSION_SECRET',
  'THINGY_WEB_ORIGIN_TOKEN',
  'FASTMAIL_JMAP_TOKEN',
  'LIBRARIAN_RETRIEVE_SECRET',
  'BRAVE_SEARCH_API_KEY',
  'LIBRARIAN_GOLDEN_RETRIEVE_SECRET'
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
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  // Names only, never values.
  logEvent('info', 'runtime_secrets_loaded', {
    keys: Object.keys(values).sort(),
    empty: Object.keys(values)
      .filter((key) => !values[key])
      .sort()
  });
}

/**
 * Make sure the runtime secret is in process.env before a handler runs.
 * A no-op when LIBRARIAN_RUNTIME_SECRET_ARN is unset (local runs and tests,
 * which set the variables directly).
 */
export async function loadRuntimeSecrets(secrets?: SecretsClient) {
  const secretId = String(process.env.LIBRARIAN_RUNTIME_SECRET_ARN || '').trim();
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
