// Own native endpoint policies and release readbacks. CloudFormation owns
// revision creation and promotion; this writer never changes endpoint weights.
import {
  LambdaWebClient,
  GetWebFunctionEndpointCommand,
  GetResourcePolicyCommand,
  PutResourcePolicyCommand
} from '@aws-sdk/client-lambda-web';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function originPolicy(arn, distributions) {
  return {
    Version: '2012-10-17',
    Statement: distributions.map((id, i) => ({
      Sid: `LibrarianCloudFront${i}`,
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 'lambda:InvokeWebFunctionEndpoint',
      Resource: arn,
      Condition: { StringEquals: { 'aws:SourceArn': `arn:aws:cloudfront::999153317627:distribution/${id}` } }
    }))
  };
}
export function servingRevision(endpoint) {
  if (
    endpoint.state !== 'Active' ||
    endpoint.authType !== 'IamAuth' ||
    endpoint.autoDeploymentMode !== 'Disabled' ||
    endpoint.endpointType !== 'HomeRegion' ||
    endpoint.revisionWeights?.length !== 1 ||
    endpoint.revisionWeights[0].weight !== 100
  )
    throw new Error('Endpoint is not active, private and pinned');
  return endpoint.revisionWeights[0].revisionId;
}
export async function snapshot(web, names) {
  const pins = {};
  for (const door of ['Auth', 'Archive'])
    for (const endpoint of ['Live', 'Rollback']) {
      const read = await web.send(
        new GetWebFunctionEndpointCommand({
          functionName: names[`Native${door}FunctionName`],
          endpointName: endpoint.toLowerCase()
        })
      );
      pins[`Native${door}${endpoint}Revision`] = servingRevision(read);
    }
  return pins;
}
export async function grantOrigins(web, outputs, receiptDir) {
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  for (const door of ['Auth', 'Archive']) {
    const endpoint = outputs[`Native${door}LiveArn`];
    if (!endpoint?.endsWith('/endpoint/live')) throw new Error('Missing live endpoint');
    const resourceArn = endpoint.split('/endpoint/')[0];
    const expected = originPolicy(endpoint, ['E1B4701J4D74H7', 'E18I2CIBERFMB7']);
    let read;
    try {
      read = await web.send(new GetResourcePolicyCommand({ resourceArn }));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
    if (read?.policy && JSON.stringify(JSON.parse(read.policy)) !== JSON.stringify(expected))
      throw new Error('Refusing an unowned origin policy');
    if (!read?.policy) {
      writeFileSync(resolve(receiptDir, `${door}.json`), JSON.stringify({ resourceArn, expected, intent: 'install' }), {
        mode: 0o600
      });
      await web.send(
        new PutResourcePolicyCommand({
          resourceArn,
          policy: JSON.stringify(expected),
          ...(read?.revisionId ? { revisionId: read.revisionId } : {})
        })
      );
    }
    const verified = await web.send(new GetResourcePolicyCommand({ resourceArn }));
    if (JSON.stringify(JSON.parse(verified.policy)) !== JSON.stringify(expected))
      throw new Error('Origin policy readback differs');
    writeFileSync(
      resolve(receiptDir, `${door}.json`),
      JSON.stringify({ resourceArn, expected, policyRevision: verified.revisionId, verified: true }),
      { mode: 0o600 }
    );
  }
}
export async function probe(outputs) {
  const signer = new SignatureV4({
    service: 'lambda',
    region: 'us-east-1',
    credentials: defaultProvider(),
    sha256: Sha256
  });
  for (const door of ['Auth', 'Archive']) {
    const hostname = outputs['Native' + door + 'CandidateDomain'];
    const signed = await signer.sign(
      new HttpRequest({ protocol: 'https:', hostname, method: 'GET', path: '/health', headers: { host: hostname } })
    );
    const response = await fetch('https://' + hostname + '/health', {
      headers: signed.headers,
      signal: AbortSignal.timeout(30000)
    });
    if (response.status !== 200 || !(await response.json()).ok) throw new Error(door + ' native HTTP probe failed');
  }
}
async function main() {
  const [action, path] = process.argv.slice(2);
  const outputs = JSON.parse(readFileSync(path, 'utf8'));
  const web = new LambdaWebClient({ region: 'us-east-1', maxAttempts: 1 });
  if (action === 'snapshot') console.log(JSON.stringify(await snapshot(web, outputs)));
  else if (action === 'grant') await grantOrigins(web, outputs, resolve(path, '..', 'native-policy-receipts'));
  else if (action === 'probe') await probe(outputs);
  else throw new Error('Expected snapshot or grant');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
