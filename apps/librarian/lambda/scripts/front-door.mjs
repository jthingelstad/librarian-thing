// Explicit owner of the existing manually managed Librarian distribution.
// Save a private rollback receipt before a CAS update; never touch Thingy's
// CloudFormation-owned distribution through this writer.
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudWatchLogsClient,
  CreateDeliveryCommand,
  CreateLogGroupCommand,
  DescribeDeliveriesCommand,
  DescribeLogGroupsCommand,
  GetDeliveryDestinationCommand,
  GetDeliverySourceCommand,
  ListTagsForResourceCommand,
  PutDeliveryDestinationCommand,
  PutDeliverySourceCommand,
  PutRetentionPolicyCommand
} from '@aws-sdk/client-cloudwatch-logs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ID = 'E18I2CIBERFMB7';
const ACCOUNT = '999153317627';
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

// Access logging for the distribution (Jamie, 2026-10-26: "Approved: add
// /librarian/web-access CloudFront access logging for E18I2CIBERFMB7 through
// librarian-thing's front-door.mjs, outside the stack"). The same shape as
// Linking Things and Weekly Thing: CloudWatch Logs vended delivery, JSON, 731
// days (24 months; Jamie, 2026-10-28), and no client IP, query string or
// path in the record: GET /share/{token} carries a share token in the path. The service role
// cannot manage these, so this operator command owns them, like the
// distribution itself.
export const ACCESS_LOG = Object.freeze({
  logGroup: '/librarian/web-access',
  retentionDays: 731,
  source: 'librarian-web-access',
  destination: 'librarian-web-access',
  distributionArn: `arn:aws:cloudfront::${ACCOUNT}:distribution/${ID}`,
  logGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/librarian/web-access`,
  // The account tag standard (projects-sysadmin docs/AWS-TAGS.md), as aws.py
  // tags what it makes outside the stack.
  tags: Object.freeze({
    Application: 'Thingelstad',
    Project: 'librarian',
    Environment: 'production',
    ManagedBy: 'repository',
    Repository: 'jthingelstad/librarian-thing'
  }),
  fields: Object.freeze([
    'timestamp(ms)',
    'cs-method',
    'sc-status',
    'sc-bytes',
    'sc-range-start',
    'sc-range-end',
    'time-taken',
    'time-to-first-byte',
    'x-edge-result-type',
    'x-edge-detailed-result-type',
    'x-edge-location',
    'cs-protocol',
    'cs(User-Agent)'
  ])
});
const bareLogGroupArn = (arn) => (arn || '').replace(/:\*$/, '');
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);

// What is missing (to create) and what differs (to refuse). A piece that
// exists but differs is never rewritten: the operator decides.
export function accessLogPlan({ logGroup, logGroupTags, source, destination, deliveries }) {
  const want = ACCESS_LOG;
  const create = [];
  const mismatches = [];
  if (!logGroup) create.push('logGroup');
  else {
    if (logGroup.retentionInDays !== want.retentionDays)
      mismatches.push(
        `log group retention is ${logGroup.retentionInDays ?? 'never expire'}, want ${want.retentionDays}`
      );
    for (const [key, value] of Object.entries(want.tags))
      if (logGroupTags?.[key] !== value) mismatches.push(`log group tag ${key} is ${logGroupTags?.[key] ?? 'missing'}`);
  }
  if (!source) create.push('source');
  else {
    if (source.logType !== 'ACCESS_LOGS') mismatches.push(`delivery source log type is ${source.logType}`);
    if (!sameList(source.resourceArns, [want.distributionArn]))
      mismatches.push(`delivery source reads ${JSON.stringify(source.resourceArns)}`);
  }
  if (!destination) create.push('destination');
  else {
    if (destination.outputFormat !== 'json')
      mismatches.push(`delivery destination format is ${destination.outputFormat}`);
    const target = bareLogGroupArn(destination.deliveryDestinationConfiguration?.destinationResourceArn);
    if (target !== want.logGroupArn) mismatches.push(`delivery destination writes to ${target}`);
  }
  const ours = (deliveries || []).filter((delivery) => delivery.deliverySourceName === want.source);
  if (ours.length === 0) create.push('delivery');
  else if (ours.length > 1) mismatches.push(`${ours.length} deliveries read ${want.source}`);
  else {
    const [delivery] = ours;
    if (!delivery.deliveryDestinationArn?.endsWith(`:delivery-destination:${want.destination}`))
      mismatches.push(`delivery writes to ${delivery.deliveryDestinationArn}`);
    if (!sameList(delivery.recordFields, want.fields))
      mismatches.push(`delivery fields are ${JSON.stringify(delivery.recordFields)}`);
  }
  return { create, mismatches };
}

const notFound = (error) => error?.name === 'ResourceNotFoundException';
async function readAccessLogs(logs) {
  const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: ACCESS_LOG.logGroup }));
  const logGroup = (groups.logGroups || []).find((group) => group.logGroupName === ACCESS_LOG.logGroup) || null;
  const logGroupTags = logGroup
    ? (await logs.send(new ListTagsForResourceCommand({ resourceArn: ACCESS_LOG.logGroupArn }))).tags || {}
    : null;
  const source = await logs
    .send(new GetDeliverySourceCommand({ name: ACCESS_LOG.source }))
    .then((response) => response.deliverySource)
    .catch((error) => (notFound(error) ? null : Promise.reject(error)));
  const destination = await logs
    .send(new GetDeliveryDestinationCommand({ name: ACCESS_LOG.destination }))
    .then((response) => response.deliveryDestination)
    .catch((error) => (notFound(error) ? null : Promise.reject(error)));
  const deliveries = [];
  let nextToken;
  do {
    const page = await logs.send(new DescribeDeliveriesCommand({ nextToken }));
    deliveries.push(...(page.deliveries || []));
    nextToken = page.nextToken;
  } while (nextToken);
  return { logGroup, logGroupTags, source, destination, deliveries };
}

// `access-logs` creates what is missing; `access-logs --check` only reads.
// Either refuses on any mismatch before writing anything.
async function accessLogs(checkOnly) {
  const logs = new CloudWatchLogsClient({ region: 'us-east-1', maxAttempts: 3 });
  const plan = accessLogPlan(await readAccessLogs(logs));
  if (plan.mismatches.length)
    throw new Error(`Access logging differs from source; refusing:\n- ${plan.mismatches.join('\n- ')}`);
  if (checkOnly) {
    console.log(
      JSON.stringify({ distribution: ID, accessLogs: plan.create.length ? 'missing' : 'ok', missing: plan.create })
    );
    if (plan.create.length) process.exitCode = 1;
    return;
  }
  const tags = { ...ACCESS_LOG.tags };
  if (plan.create.includes('logGroup')) {
    await logs.send(new CreateLogGroupCommand({ logGroupName: ACCESS_LOG.logGroup, tags }));
    await logs.send(
      new PutRetentionPolicyCommand({ logGroupName: ACCESS_LOG.logGroup, retentionInDays: ACCESS_LOG.retentionDays })
    );
  }
  if (plan.create.includes('source'))
    await logs.send(
      new PutDeliverySourceCommand({
        name: ACCESS_LOG.source,
        resourceArn: ACCESS_LOG.distributionArn,
        logType: 'ACCESS_LOGS',
        tags
      })
    );
  let destinationArn;
  if (plan.create.includes('destination')) {
    const made = await logs.send(
      new PutDeliveryDestinationCommand({
        name: ACCESS_LOG.destination,
        outputFormat: 'json',
        deliveryDestinationConfiguration: { destinationResourceArn: ACCESS_LOG.logGroupArn },
        tags
      })
    );
    destinationArn = made.deliveryDestination.arn;
  }
  if (plan.create.includes('delivery')) {
    destinationArn ??= (await logs.send(new GetDeliveryDestinationCommand({ name: ACCESS_LOG.destination })))
      .deliveryDestination.arn;
    await logs.send(
      new CreateDeliveryCommand({
        deliverySourceName: ACCESS_LOG.source,
        deliveryDestinationArn: destinationArn,
        recordFields: [...ACCESS_LOG.fields],
        tags
      })
    );
  }
  const verified = accessLogPlan(await readAccessLogs(logs));
  if (verified.create.length || verified.mismatches.length)
    throw new Error(`Access logging readback differs: ${JSON.stringify(verified)}`);
  console.log(JSON.stringify({ distribution: ID, accessLogs: 'ok', created: plan.create }));
}

async function main() {
  if (process.argv[2] === 'access-logs') return accessLogs(process.argv[3] === '--check');
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
