import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_LOG,
  AUTHORIZE_PATH,
  accessLogPlan,
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

test('a pending canonical receipt is checked against the hash it recorded, not a rebuild from moved outputs', () => {
  const intended = nativeConfig(original, outputs);
  const prior = {
    original,
    mode: 'native',
    hashFormat: 'canonical-json-v1',
    intendedHash: configurationHash(intended)
  };
  const moved = { ...outputs, NativeAuthLiveDomain: 'auth-2.lambda-web.us-east-1.on.aws' };
  // CloudFront applied the intent, then a stack output moved before recovery: still the recorded intent.
  assert.doesNotThrow(() => verifyPriorConfig(prior, reorder(intended), moved));
  // The distribution matches a rebuild from the moved outputs, but not what the receipt meant.
  assert.throws(() => verifyPriorConfig(prior, nativeConfig(original, moved), moved), /differs from its intent/);
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

const matching = () => ({
  logGroup: { logGroupName: '/librarian/web-access', retentionInDays: 14 },
  logGroupTags: { ...ACCESS_LOG.tags },
  source: { logType: 'ACCESS_LOGS', resourceArns: ['arn:aws:cloudfront::999153317627:distribution/E18I2CIBERFMB7'] },
  destination: {
    outputFormat: 'json',
    deliveryDestinationConfiguration: {
      destinationResourceArn: 'arn:aws:logs:us-east-1:999153317627:log-group:/librarian/web-access:*'
    }
  },
  deliveries: [
    { deliverySourceName: 'links-web-access', recordFields: ['timestamp(ms)'] },
    {
      deliverySourceName: 'librarian-web-access',
      deliveryDestinationArn: 'arn:aws:logs:us-east-1:999153317627:delivery-destination:librarian-web-access',
      recordFields: [...ACCESS_LOG.fields]
    }
  ]
});

test('access logging records no client IP, query string or path (share tokens ride in it)', () => {
  assert.equal(ACCESS_LOG.fields.length, 13);
  for (const field of ACCESS_LOG.fields)
    assert.ok(!/c-ip|query|uri-stem|referer|cookie|x-forwarded/i.test(field), field);
  assert.equal(ACCESS_LOG.retentionDays, 14);
  assert.equal(ACCESS_LOG.tags.Project, 'librarian');
});

test('access logging is a no-op when everything matches', () => {
  assert.deepEqual(accessLogPlan(matching()), { create: [], mismatches: [] });
});

test('access logging creates every missing piece and only those', () => {
  assert.deepEqual(accessLogPlan({ logGroup: null, source: null, destination: null, deliveries: [] }), {
    create: ['logGroup', 'source', 'destination', 'delivery'],
    mismatches: []
  });
  const partial = { ...matching(), deliveries: [] };
  assert.deepEqual(accessLogPlan(partial), { create: ['delivery'], mismatches: [] });
});

test('access logging refuses a piece that exists but differs', () => {
  const cases = [
    (s) => (s.logGroup.retentionInDays = 30),
    (s) => delete s.logGroupTags.Project,
    (s) => (s.source.resourceArns = ['arn:aws:cloudfront::999153317627:distribution/OTHER']),
    (s) => (s.destination.outputFormat = 'plain'),
    (s) => (s.destination.deliveryDestinationConfiguration.destinationResourceArn = 'arn:aws:s3:::bucket'),
    (s) => s.deliveries[1].recordFields.push('c-ip'),
    (s) => (s.deliveries[1].recordFields = [...ACCESS_LOG.fields].reverse()),
    (s) => s.deliveries.push({ ...s.deliveries[1] })
  ];
  for (const change of cases) {
    const state = matching();
    change(state);
    const plan = accessLogPlan(state);
    assert.equal(plan.mismatches.length, 1, JSON.stringify(plan));
  }
});
