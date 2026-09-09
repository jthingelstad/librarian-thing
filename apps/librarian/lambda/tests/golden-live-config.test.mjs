import assert from 'node:assert/strict';
import test from 'node:test';
import { goldenRunnerEnvironment } from '../scripts/golden-live-config.mjs';

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
