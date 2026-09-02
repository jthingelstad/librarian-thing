import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractModule = await import('../dist/shared/librarian-contract.mjs');
const http = await import('../dist/shared/http.mjs');
const artifactUrl = new URL('../../contracts/librarian-api.json', import.meta.url);
const artifactContent = await readFile(artifactUrl, 'utf8');
const artifact = JSON.parse(artifactContent);
const artifactChecksum = (await readFile(new URL('../../contracts/librarian-api.sha256', import.meta.url), 'utf8'))
  .trim()
  .split(/\s+/)[0];

test('generated Librarian contract artifact matches the backend source', () => {
  assert.deepEqual(artifact, contractModule.LIBRARIAN_CONTRACT);
  assert.equal(artifact.version, contractModule.LIBRARIAN_CONTRACT_VERSION);
  assert.equal(createHash('sha256').update(artifactContent).digest('hex'), artifactChecksum);
});

test('contract negotiation accepts supported majors and rejects the rest', () => {
  assert.equal(contractModule.supportsRequestedContract({}), true);
  assert.equal(contractModule.supportsRequestedContract({ 'X-Librarian-Contract-Version': artifact.version }), true);
  // 2.x clients predate the chat streamline and stay accepted until the
  // deployed web client vendors 3.0.0.
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': '2.0.0' }), true);
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': '3.4.0' }), true);
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': '4.1.0' }), true);
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': '1.0.0' }), false);
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': '5.0.0' }), false);
  assert.equal(contractModule.supportsRequestedContract({ 'x-librarian-contract-version': 'not-semver' }), false);
});

test('endpoint actions declare response-specific successful contracts', () => {
  assert.deepEqual(artifact.endpoints['/conversations'].actions.list.required, ['conversations']);
  assert.deepEqual(artifact.endpoints['/chat'].request.required, ['message']);
  assert.deepEqual(artifact.endpoints['/retrieve'].request.required, ['query']);
  assert.deepEqual(artifact.endpoints['/conversations'].actions.share.required, ['share']);
  assert.deepEqual(artifact.endpoints['/share/{token}'].schema.required, ['conversation', 'messages']);
  assert.equal('email_answer' in artifact.endpoints['/conversations'].actions, false);
  assert.equal('/dispatch' in artifact.endpoints, false);
  assert.equal('/curiosity-map' in artifact.endpoints, false);
  assert.equal('experience' in artifact.stream_events, false);
});

test('JSON responses advertise the authoritative contract version', () => {
  const response = http.jsonResponse(200, { ok: true });
  assert.equal(response.headers['x-librarian-contract-version'], artifact.version);
  assert.match(response.headers['access-control-allow-headers'], /x-librarian-contract-version/);
  assert.match(response.headers['access-control-expose-headers'], /x-librarian-contract-version/);
});
