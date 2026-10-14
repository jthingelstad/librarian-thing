// Explicit owner of the existing manually managed Librarian distribution.
// Save a private rollback receipt before a CAS update; never touch Thingy's
// CloudFormation-owned distribution through this writer.
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from '@aws-sdk/client-cloudfront';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ID = 'E18I2CIBERFMB7';
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
  } else {
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
  for (const behavior of [next.DefaultCacheBehavior, ...next.CacheBehaviors.Items]) {
    if (
      behavior.TargetOriginId === 'LibrarianApiGatewayOrigin' ||
      behavior.TargetOriginId === 'LibrarianStreamFunctionUrlOrigin'
    ) {
      delete behavior.ForwardedValues;
      delete behavior.MinTTL;
      delete behavior.DefaultTTL;
      delete behavior.MaxTTL;
      behavior.CachePolicyId = outputs.NativeExternalCachePolicy;
      behavior.OriginRequestPolicyId = outputs.NativeExternalRequestPolicy;
      behavior.Compress = false;
    }
  }
  next.DefaultCacheBehavior.FunctionAssociations = {
    Quantity: 1,
    Items: [{ EventType: 'viewer-request', FunctionARN: outputs.NativeExternalOAuthFunction }]
  };
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
