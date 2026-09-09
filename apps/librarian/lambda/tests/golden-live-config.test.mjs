import assert from 'node:assert/strict';
import test from 'node:test';
import { asmExecInvocation, goldenRunnerEnvironment, resolveAsmExec } from '../scripts/golden-live-config.mjs';

test('golden runner resolves only the generated harness secret', () => {
  const environment = goldenRunnerEnvironment({
    LibrarianStreamUrl: 'https://librarian.example.test',
    LibrarianGoldenRetrieveSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:golden-AbCd12'
  });

  assert.deepEqual(environment, {
    LIBRARIAN_STREAM_URL: 'https://librarian.example.test',
    LIBRARIAN_RETRIEVE_SECRET:
      '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:golden-AbCd12:SecretString:value}}'
  });
});

test('golden runner refuses incomplete stack outputs', () => {
  assert.throws(() => goldenRunnerEnvironment({}), /LibrarianStreamUrl/);
  assert.throws(() => goldenRunnerEnvironment({ LibrarianStreamUrl: 'https://librarian.example.test' }), /GoldenRetrieveSecretArn/);
});

test('golden runner finds the bundled resolver without CODEX_HOME', () => {
  const resolver = '/Users/operator/.codex/skills/aws-secrets-manager/references/asm-exec';
  assert.equal(
    resolveAsmExec({ codexHome: '', home: '/Users/operator', exists: (candidate) => candidate === resolver }),
    resolver
  );
  assert.equal(
    resolveAsmExec({ asmExec: '/custom/asm-exec', codexHome: '', home: '', exists: () => false }),
    '/custom/asm-exec'
  );
});

test('golden runner invokes non-executable resolver source through Python', () => {
  assert.deepEqual(asmExecInvocation('/tmp/asm-exec', false), ['python3', '/tmp/asm-exec']);
  assert.deepEqual(asmExecInvocation('/usr/local/bin/asm-exec', true), ['/usr/local/bin/asm-exec']);
});
