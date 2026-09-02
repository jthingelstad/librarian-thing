import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

export const bedrock = new BedrockRuntimeClient({});
export const bedrockAgentRuntime = new BedrockAgentRuntimeClient({
  region: process.env.BEDROCK_RERANK_REGION || 'us-west-2'
});
export const dynamodb = new DynamoDBClient({});
export const s3 = new S3Client({});

export const DEFAULT_THINGY_MODEL = 'us.anthropic.claude-sonnet-4-6';
export const FAST_THINGY_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
// Supporters and the owner get the Opus tier (Jamie's call, 2026-09-02).
// THINGY_ADVANCED_MODEL, the old third slot, was a Dispatch-era artifact
// that no code path ever invoked; premium replaces it with a real route.
// Interim: the account's Bedrock backend quotas for the 5-generation are
// pending an AWS support case; until the 403 clears these fallbacks (and
// the CFN env values) stay on the invokable 4.6 generation.
export const PREMIUM_THINGY_MODEL = 'us.anthropic.claude-opus-4-6-v1';

export function thingyDefaultModel() {
  return process.env.THINGY_DEFAULT_MODEL || DEFAULT_THINGY_MODEL;
}

export function fastModel() {
  return process.env.THINGY_FAST_MODEL || FAST_THINGY_MODEL;
}

export function premiumModel() {
  return process.env.THINGY_PREMIUM_MODEL || PREMIUM_THINGY_MODEL;
}

export function agentModel() {
  return thingyDefaultModel();
}

// The Claude 5 family (and Opus 4.7/4.8) rejects sampling parameters -
// sending temperature to those models is a ValidationException, not a
// no-op. Gate inferenceConfig on this before adding temperature.
export function modelAcceptsSamplingParams(modelId: string) {
  return !/(sonnet-5|opus-5|opus-4-7|opus-4-8|fable)/.test(modelId);
}

export function embeddingModel() {
  return process.env.BEDROCK_EMBEDDING_MODEL || 'cohere.embed-english-v3';
}

export function rerankModel() {
  return process.env.BEDROCK_RERANK_MODEL || 'cohere.rerank-v3-5:0';
}
