import assert from 'node:assert/strict';
import test from 'node:test';
import { originPolicy, servingRevision, snapshot, grantOrigins } from '../scripts/native-release.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('origin grant is endpoint- and distribution-scoped, never public', () => {
  const policy=originPolicy('arn:example/endpoint/live',['D1','D2']);
  assert.equal(policy.Statement.length,2);
  for(const statement of policy.Statement) {
    assert.deepEqual(statement.Principal,{Service:'cloudfront.amazonaws.com'});
    assert.equal(statement.Resource,'arn:example/endpoint/live');
    assert.match(statement.Condition.StringEquals['aws:SourceArn'],/distribution\/D[12]$/);
  }
});
test('only active private single-revision endpoints can be release pins', () => {
  const endpoint={state:'Active',authType:'IamAuth',autoDeploymentMode:'Disabled',endpointType:'HomeRegion',revisionWeights:[{revisionId:'rev-good',weight:100}]};
  assert.equal(servingRevision(endpoint),'rev-good');
  for(const patch of [{authType:'ApplicationManaged'},{autoDeploymentMode:'LatestRevision'},{revisionWeights:[{revisionId:'bad',weight:50}]}]) assert.throws(()=>servingRevision({...endpoint,...patch}));
});
test('unowned resource policies fail closed without a write', async () => {
  const calls=[];const web={send:async(command)=>{calls.push(command.constructor.name);return {policy:JSON.stringify({Version:'2012-10-17',Statement:[]})};}};
  const dir=await mkdtemp(join(tmpdir(),'native-policy-test-'));
  try { await assert.rejects(grantOrigins(web,{NativeAuthLiveArn:'arn:example/endpoint/live'},dir),/unowned/);assert.deepEqual(calls,['GetResourcePolicyCommand']); }
  finally {await rm(dir,{recursive:true,force:true});}
});
test('preparation reads all live and protected rollback targets', async () => {
  const seen=[];const web={send:async(c)=>{seen.push(c.input);return {state:'Active',authType:'IamAuth',autoDeploymentMode:'Disabled',endpointType:'HomeRegion',revisionWeights:[{revisionId:c.input.functionName+'-'+c.input.endpointName,weight:100}]};}};
  const pins=await snapshot(web,{NativeAuthFunctionName:'auth',NativeArchiveFunctionName:'archive'});
  assert.equal(seen.length,4);assert.equal(pins.NativeArchiveRollbackRevision,'archive-rollback');
});
