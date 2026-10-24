// Explicit owner of the existing manually managed Librarian distribution.
// Save a private rollback receipt before a CAS update; never touch Thingy's
// CloudFormation-owned distribution through this writer.
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from '@aws-sdk/client-cloudfront';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ID = 'E18I2CIBERFMB7';
export const AUTHORIZE_PATH = '/authorize';
// Routes the code no longer serves. Their behaviors are dropped so the
// distribution's route inventory matches the Lambdas (curiosity map retired
// with the 2026-08 chat streamline; contract.test.mjs pins it gone).
export const RETIRED_PATHS = ['/curiosity-map'];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
export const configurationHash = (config) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(config)))
    .digest('hex');
const digest = configurationHash;
export function verifyPriorConfig(prior, current, outputs) {
  if (!prior) return;
  if (prior.appliedHash) {
    const hash =
      prior.hashFormat === 'canonical-json-v1'
        ? digest(current)
        : createHash('sha256').update(JSON.stringify(current)).digest('hex');
    if (hash !== prior.appliedHash) throw new Error('Distribution changed outside this release; refusing');
  } else if (prior.hashFormat === 'canonical-json-v1' && prior.intendedHash) {
    // The receipt recorded what it meant to apply; compare with that, not
    // with a rebuild from today's outputs, which may have moved since
    // (Codex review, #78).
    if (digest(current) !== prior.intendedHash)
      throw new Error('Unverified prior update differs from its intent; refusing');
  } else {
    // A legacy receipt kept no intended hash: rebuild the intent it had.
    const intended = nativeConfig(prior.original, outputs, prior.mode);
    if (digest(current) !== digest(intended))
      throw new Error('Unverified prior update differs from its intent; refusing');
  }
}
export function nativeConfig(config, outputs, mode = 'native') {
  if (mode !== 'native') throw new Error('Legacy routing is retired; expected native');
  const next = structuredClone(config);
  if (!Array.isArray(next.Aliases.Items) || !next.Aliases.Items.some((alias) => alias === 'librarian.thingelstad.com'))
    throw new Error('Wrong distribution');
  for (const origin of next.Origins.Items) {
    const isAuth = origin.Id === 'LibrarianApiGatewayOrigin';
    const isArchive = origin.Id === 'LibrarianStreamFunctionUrlOrigin';
    if (isAuth || isArchive) {
      origin.DomainName = outputs[`Native${isAuth ? 'Auth' : 'Archive'}LiveDomain`];
      if (!origin.DomainName?.endsWith('.lambda-web.us-east-1.on.aws')) throw new Error('Invalid native origin domain');
      origin.OriginAccessControlId = outputs.NativeExternalOriginAccess;
    }
  }
  if (!outputs.NativeCompressedCachePolicy) throw new Error('Missing NativeCompressedCachePolicy output');
  next.CacheBehaviors.Items = (next.CacheBehaviors.Items || []).filter(
    (behavior) => !RETIRED_PATHS.includes(behavior.PathPattern)
  );
  next.CacheBehaviors.Quantity = next.CacheBehaviors.Items.length;
  for (const behavior of [next.DefaultCacheBehavior, ...next.CacheBehaviors.Items]) {
    const isAuth = behavior.TargetOriginId === 'LibrarianApiGatewayOrigin';
    if (isAuth || behavior.TargetOriginId === 'LibrarianStreamFunctionUrlOrigin') {
      delete behavior.ForwardedValues;
      delete behavior.MinTTL;
      delete behavior.DefaultTTL;
      delete behavior.MaxTTL;
      // The auth origin answers plain request/response JSON and HTML, so its
      // behaviors compress. Archive behaviors never do: /chat and /mcp stream
      // SSE, and compression would buffer it.
      behavior.CachePolicyId = isAuth ? outputs.NativeCompressedCachePolicy : outputs.NativeExternalCachePolicy;
      behavior.OriginRequestPolicyId = outputs.NativeExternalRequestPolicy;
      behavior.Compress = isAuth;
    }
  }
  next.DefaultCacheBehavior.FunctionAssociations = {
    Quantity: 1,
    Items: [{ EventType: 'viewer-request', FunctionARN: outputs.NativeExternalOAuthFunction }]
  };
  // /authorize is the auth origin's default behavior plus one cookie:
  // thingy_email, the remembered sign-in email (Path=/authorize). Its own
  // behavior keeps every other auth route cookie-free in both directions.
  if (!outputs.NativeAuthorizeRequestPolicy) throw new Error('Missing NativeAuthorizeRequestPolicy output');
  const authorize = {
    ...structuredClone(next.DefaultCacheBehavior),
    PathPattern: AUTHORIZE_PATH,
    OriginRequestPolicyId: outputs.NativeAuthorizeRequestPolicy
  };
  const others = (next.CacheBehaviors.Items || []).filter((behavior) => behavior.PathPattern !== AUTHORIZE_PATH);
  next.CacheBehaviors = { Quantity: others.length + 1, Items: [authorize, ...others] };
  return next;
}
async function main() {
  const [mode, outputFile, receiptDir] = process.argv.slice(2);
  if (mode !== 'native' || !receiptDir)
    throw new Error('Expected native outputs.json private-receipt-dir; legacy routing is retired');
  const cloudfront = new CloudFrontClient({ region: 'us-east-1', maxAttempts: 1 });
  const current = await cloudfront.send(new GetDistributionConfigCommand({ Id: ID }));
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const path = resolve(receiptDir, 'librarian-distribution.json');
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const outputs = JSON.parse(readFileSync(outputFile, 'utf8'));
  verifyPriorConfig(prior, current.DistributionConfig, outputs);
  const desired = nativeConfig(current.DistributionConfig, outputs, mode);
  const receipt = {
    original: prior?.original || current.DistributionConfig,
    priorETag: current.ETag,
    mode,
    hashFormat: 'canonical-json-v1',
    intendedHash: digest(desired)
  };
  writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
  await cloudfront.send(new UpdateDistributionCommand({ Id: ID, IfMatch: current.ETag, DistributionConfig: desired }));
  const verified = await cloudfront.send(new GetDistributionConfigCommand({ Id: ID }));
  if (digest(verified.DistributionConfig) !== digest(desired)) throw new Error('Distribution readback differs');
  writeFileSync(path, JSON.stringify({ ...receipt, appliedHash: digest(desired), appliedETag: verified.ETag }), {
    mode: 0o600
  });
  console.log(JSON.stringify({ distribution: ID, mode, configurationVerified: true }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
