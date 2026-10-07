// The Lambdas read their credentials from one Secrets Manager secret at cold
// start instead of plaintext function configuration: values land in
// process.env, only names are logged, the read is cached, a failure retries,
// and a failed read refuses rather than running unkeyed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_SECRET_KEYS,
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
  runtimeSecretValues
} from '../dist/shared/runtime-secrets.mjs';

const SECRET_ID = 'weekly-thing-librarian-runtime';
const SECRET = {
  BUTTONDOWN_API_KEY: 'bd-value',
  SESSION_SECRET: 'session-value',
  THINGY_WEB_ORIGIN_TOKEN: 'origin-value',
  FASTMAIL_JMAP_TOKEN: 'jmap-value',
  LIBRARIAN_RETRIEVE_SECRET: 'retrieve-value',
  LIBRARIAN_GOLDEN_RETRIEVE_SECRET: 'golden-value',
  ANTHROPIC_API_KEY: '',
  // A retired name left in the secret is ignored.
  BRAVE_SEARCH_API_KEY: '',
  UNRELATED: 'ignored'
};

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command.input);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { SecretString: next };
    }
  };
}

// Run with a clean slate of the managed variables, restored afterwards.
async function withEnv(env, run) {
  const saved = {};
  for (const key of [...RUNTIME_SECRET_KEYS, 'LIBRARIAN_RUNTIME_SECRET_ID']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  resetRuntimeSecretsForTests();
  try {
    await run(lines);
  } finally {
    console.log = log;
    resetRuntimeSecretsForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('without a secret id the loader does nothing (local runs and tests)', async () => {
  await withEnv({}, async () => {
    const client = fakeClient([]);
    await loadRuntimeSecrets(client);
    assert.equal(client.calls.length, 0);
  });
});

test('the secret fills process.env once, and the log names keys but never values', async () => {
  await withEnv({ LIBRARIAN_RUNTIME_SECRET_ID: SECRET_ID }, async (lines) => {
    const client = fakeClient([JSON.stringify(SECRET)]);
    await loadRuntimeSecrets(client);
    await loadRuntimeSecrets(client);
    assert.equal(client.calls.length, 1, 'one read per cold start');
    assert.equal(client.calls[0].SecretId, SECRET_ID);
    for (const key of RUNTIME_SECRET_KEYS) assert.equal(process.env[key], SECRET[key], key);
    assert.equal(process.env.UNRELATED, undefined, 'only the known names are taken');
    assert.equal(process.env.BRAVE_SEARCH_API_KEY, undefined, 'a retired name is not taken');
    const logged = lines.join('\n');
    assert.match(logged, /runtime_secrets_loaded/);
    assert.match(logged, /BUTTONDOWN_API_KEY/);
    for (const value of Object.values(SECRET).filter(Boolean)) {
      assert.equal(logged.includes(value), false, `the log must not carry ${value}`);
    }
    const event = JSON.parse(lines.find((line) => line.includes('runtime_secrets_loaded')));
    assert.deepEqual(event.empty, ['ANTHROPIC_API_KEY']);
    assert.deepEqual(event.missing, []);
  });
});

test('a name the secret lacks is logged as missing', async () => {
  const { FASTMAIL_JMAP_TOKEN, ...partial } = SECRET;
  await withEnv({ LIBRARIAN_RUNTIME_SECRET_ID: SECRET_ID }, async (lines) => {
    await loadRuntimeSecrets(fakeClient([JSON.stringify(partial)]));
    const event = JSON.parse(lines.find((line) => line.includes('runtime_secrets_loaded')));
    assert.deepEqual(event.missing, ['FASTMAIL_JMAP_TOKEN']);
    assert.equal(lines.join('\n').includes(FASTMAIL_JMAP_TOKEN), false);
  });
});

test('a failed read refuses and the next call retries', async () => {
  await withEnv({ LIBRARIAN_RUNTIME_SECRET_ID: SECRET_ID }, async () => {
    const client = fakeClient([new Error('AccessDeniedException'), JSON.stringify(SECRET)]);
    await assert.rejects(loadRuntimeSecrets(client), /Runtime credentials are unavailable/);
    assert.equal(process.env.SESSION_SECRET, undefined);
    await loadRuntimeSecrets(client);
    assert.equal(client.calls.length, 2);
    assert.equal(process.env.SESSION_SECRET, 'session-value');
  });
});

test('a failed read refuses even when a value is already in the environment', async () => {
  await withEnv({ LIBRARIAN_RUNTIME_SECRET_ID: SECRET_ID, SESSION_SECRET: 'stale' }, async (lines) => {
    const client = fakeClient([new Error('AccessDeniedException')]);
    await assert.rejects(loadRuntimeSecrets(client), /Runtime credentials are unavailable/);
    assert.match(lines.join('\n'), /runtime_secrets_load_failed/);
  });
});

test('a secret that is not a JSON object is refused', () => {
  assert.throws(() => runtimeSecretValues('not json'));
  assert.throws(() => runtimeSecretValues('["a"]'), /not a JSON object/);
  assert.throws(() => runtimeSecretValues('null'), /not a JSON object/);
  assert.deepEqual(runtimeSecretValues('{"SESSION_SECRET":"x","BUTTONDOWN_API_KEY":7}'), { SESSION_SECRET: 'x' });
});
