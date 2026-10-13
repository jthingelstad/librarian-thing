import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationHash, nativeConfig, verifyPriorConfig } from '../scripts/front-door.mjs';

const original = {
  Aliases: { Items: ['librarian.thingelstad.com'] },
  Origins: {
    Items: [
      { Id: 'LibrarianApiGatewayOrigin', DomainName: 'api.example.test' },
      { Id: 'LibrarianStreamFunctionUrlOrigin', DomainName: 'stream.example.test' }
    ]
  },
  DefaultCacheBehavior: { TargetOriginId: 'LibrarianApiGatewayOrigin' },
  CacheBehaviors: { Items: [] }
};
const outputs = {
  NativeAuthLiveDomain: 'auth.lambda-web.us-east-1.on.aws',
  NativeArchiveLiveDomain: 'archive.lambda-web.us-east-1.on.aws',
  NativeExternalOriginAccess: 'native-oac',
  NativeExternalCachePolicy: 'native-cache',
  NativeExternalRequestPolicy: 'native-request',
  NativeExternalOAuthFunction: 'native-oauth-function'
};
const reorder = (value) =>
  Array.isArray(value)
    ? value.map(reorder)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reorder(item)])
        )
      : value;

test('SDK object-key normalization preserves the distribution hash', () => {
  const config = nativeConfig(original, outputs, 'auth');
  assert.equal(configurationHash(config), configurationHash(reorder(config)));
});

test('origin edits and ordered route changes remain different', () => {
  const config = nativeConfig(original, outputs, 'native');
  const edited = structuredClone(config);
  edited.Origins.Items[0].DomainName = 'unowned.example.test';
  assert.notEqual(configurationHash(config), configurationHash(edited));
  const routes = { Items: [{ PathPattern: '/api/*' }, { PathPattern: '/api/chat' }] };
  assert.notEqual(configurationHash(routes), configurationHash({ Items: [...routes.Items].reverse() }));
});

test('a pending receipt resumes only after its full intended config is verified', () => {
  const prior = { original, mode: 'auth' };
  const current = reorder(nativeConfig(original, outputs, 'auth'));
  assert.doesNotThrow(() => verifyPriorConfig(prior, current, outputs));
  current.Origins.Items[0].DomainName = 'unowned.example.test';
  assert.throws(() => verifyPriorConfig(prior, current, outputs), /differs from its intent/);
});
