import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORIZE_PATH,
  RETIRED_PATHS,
  configurationHash,
  nativeConfig,
  verifyPriorConfig
} from '../scripts/front-door.mjs';

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
  NativeCompressedCachePolicy: 'native-compressed-cache',
  NativeExternalRequestPolicy: 'native-request',
  NativeAuthorizeRequestPolicy: 'native-authorize-request',
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
  const config = nativeConfig(original, outputs);
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
  const prior = { original, mode: 'native' };
  const current = reorder(nativeConfig(original, outputs));
  assert.doesNotThrow(() => verifyPriorConfig(prior, current, outputs));
  current.Origins.Items[0].DomainName = 'unowned.example.test';
  assert.throws(() => verifyPriorConfig(prior, current, outputs), /differs from its intent/);
});

test('both origins use native endpoints and retired routing modes are refused', () => {
  const current = nativeConfig(original, outputs);
  assert.deepEqual(
    current.Origins.Items.map((origin) => origin.DomainName),
    [outputs.NativeAuthLiveDomain, outputs.NativeArchiveLiveDomain]
  );
  for (const mode of ['auth', 'legacy', 'rollback']) {
    assert.throws(() => nativeConfig(original, outputs, mode), /Legacy routing is retired/);
    assert.throws(() => verifyPriorConfig({ original, mode }, current, outputs), /Legacy routing is retired/);
  }
});

test('/authorize gets its own behavior forwarding the remembered-email cookie, and nothing else changes', () => {
  const withStream = structuredClone(original);
  withStream.CacheBehaviors = {
    Quantity: 2,
    Items: [
      { PathPattern: '/chat', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin' },
      { PathPattern: '/mcp', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin' }
    ]
  };
  const config = nativeConfig(withStream, outputs);
  const [authorize, ...rest] = config.CacheBehaviors.Items;
  assert.equal(config.CacheBehaviors.Quantity, 3);
  assert.equal(authorize.PathPattern, AUTHORIZE_PATH);
  assert.equal(authorize.TargetOriginId, 'LibrarianApiGatewayOrigin');
  assert.equal(authorize.OriginRequestPolicyId, outputs.NativeAuthorizeRequestPolicy);
  assert.equal(authorize.CachePolicyId, outputs.NativeCompressedCachePolicy);
  assert.deepEqual(authorize.FunctionAssociations, config.DefaultCacheBehavior.FunctionAssociations);
  // Every other behavior, the default included, stays cookie-free.
  for (const behavior of [config.DefaultCacheBehavior, ...rest]) {
    assert.equal(behavior.OriginRequestPolicyId, outputs.NativeExternalRequestPolicy);
  }
  assert.deepEqual(
    rest.map((behavior) => behavior.PathPattern),
    ['/chat', '/mcp']
  );
  // Re-applying to an already-native config is a no-op (one /authorize, same hash).
  const again = nativeConfig(config, outputs);
  assert.equal(again.CacheBehaviors.Items.filter((b) => b.PathPattern === AUTHORIZE_PATH).length, 1);
  assert.equal(configurationHash(again), configurationHash(config));
  assert.throws(
    () => nativeConfig(withStream, { ...outputs, NativeAuthorizeRequestPolicy: undefined }),
    /NativeAuthorizeRequestPolicy/
  );
});

test('auth behaviors compress, archive behaviors never do, and retired routes are dropped', () => {
  const live = structuredClone(original);
  live.DefaultCacheBehavior.Compress = false;
  live.CacheBehaviors = {
    Quantity: 4,
    Items: [
      { PathPattern: '/chat', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin', Compress: false },
      { PathPattern: '/curiosity-map', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin', Compress: false },
      { PathPattern: '/retrieve', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin', Compress: false },
      { PathPattern: '/mcp', TargetOriginId: 'LibrarianStreamFunctionUrlOrigin', Compress: false }
    ]
  };
  const config = nativeConfig(live, outputs);
  const paths = config.CacheBehaviors.Items.map((behavior) => behavior.PathPattern);
  assert.deepEqual(paths, [AUTHORIZE_PATH, '/chat', '/retrieve', '/mcp']);
  assert.equal(config.CacheBehaviors.Quantity, 4);
  for (const path of RETIRED_PATHS) assert.ok(!paths.includes(path));
  const [authorize, ...archive] = config.CacheBehaviors.Items;
  for (const behavior of [config.DefaultCacheBehavior, authorize]) {
    assert.equal(behavior.Compress, true);
    assert.equal(behavior.CachePolicyId, outputs.NativeCompressedCachePolicy);
  }
  // SSE stays unbuffered: no archive behavior compresses or uses the
  // Accept-Encoding cache policy.
  for (const behavior of archive) {
    assert.equal(behavior.Compress, false, behavior.PathPattern);
    assert.equal(behavior.CachePolicyId, outputs.NativeExternalCachePolicy, behavior.PathPattern);
  }
  assert.equal(configurationHash(nativeConfig(config, outputs)), configurationHash(config));
  assert.throws(
    () => nativeConfig(live, { ...outputs, NativeCompressedCachePolicy: undefined }),
    /NativeCompressedCachePolicy/
  );
});
