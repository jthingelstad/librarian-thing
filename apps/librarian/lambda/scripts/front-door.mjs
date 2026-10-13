// Explicit owner of the existing manually managed Librarian distribution.
// Save a private rollback receipt before a CAS update; never touch Thingy's
// CloudFormation-owned distribution through this writer.
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from '@aws-sdk/client-cloudfront';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ID = 'E18I2CIBERFMB7';
const digest = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function nativeConfig(config, outputs, mode) {
  const next = structuredClone(config);
  if (!next.Aliases.Items.includes('librarian.thingelstad.com')) throw new Error('Wrong distribution');
  for (const origin of next.Origins.Items) {
    const isAuth = origin.Id === 'LibrarianApiGatewayOrigin';
    const isArchive = origin.Id === 'LibrarianStreamFunctionUrlOrigin';
    if (isAuth || (isArchive && mode === 'native')) {
      origin.DomainName = outputs[`Native${isAuth ? 'Auth' : 'Archive'}LiveDomain`];
      if (!origin.DomainName?.endsWith('.lambda-web.us-east-1.on.aws')) throw new Error('Invalid native origin domain');
      origin.OriginAccessControlId = outputs.NativeExternalOriginAccess;
    }
  }
  for (const behavior of [next.DefaultCacheBehavior, ...next.CacheBehaviors.Items]) {
    if (
      behavior.TargetOriginId === 'LibrarianApiGatewayOrigin' ||
      (mode === 'native' && behavior.TargetOriginId === 'LibrarianStreamFunctionUrlOrigin')
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
  if (!['auth', 'native', 'rollback'].includes(mode) || !receiptDir)
    throw new Error('Expected auth|native|rollback outputs.json private-receipt-dir');
  const cloudfront = new CloudFrontClient({ region: 'us-east-1', maxAttempts: 1 });
  const current = await cloudfront.send(new GetDistributionConfigCommand({ Id: ID }));
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const path = resolve(receiptDir, 'librarian-distribution.json');
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (prior && prior.appliedHash && digest(current.DistributionConfig) !== prior.appliedHash)
    throw new Error('Distribution changed outside this release; refusing');
  if (!prior && mode === 'rollback') throw new Error('No owned rollback receipt');
  const outputs = JSON.parse(readFileSync(outputFile, 'utf8'));
  const desired = mode === 'rollback' ? prior.original : nativeConfig(current.DistributionConfig, outputs, mode);
  const receipt = {
    original: prior?.original || current.DistributionConfig,
    priorETag: current.ETag,
    mode,
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
