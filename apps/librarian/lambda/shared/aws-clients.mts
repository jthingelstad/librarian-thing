import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

// Cohere embed (retrieval.mts). Claude calls do not use this client.
export const bedrock = new BedrockRuntimeClient({});
export const bedrockAgentRuntime = new BedrockAgentRuntimeClient({
  region: process.env.BEDROCK_RERANK_REGION || 'us-west-2'
});
export const dynamodb = new DynamoDBClient({});
export const s3 = new S3Client({});

// Thingy's models are Anthropic API ids (shared/anthropic.mts); only the
// Cohere embed and rerank models below still run on Bedrock.
export const DEFAULT_THINGY_MODEL = 'claude-sonnet-4-6';
export const FAST_THINGY_MODEL = 'claude-haiku-4-5';
// Supporters and the owner get the Opus tier (Jamie's call, 2026-09-02).
// THINGY_ADVANCED_MODEL, the old third slot, was a Dispatch-era artifact
// that no code path ever invoked; premium replaces it with a real route.
export const PREMIUM_THINGY_MODEL = 'claude-opus-4-6';

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
// sending temperature to those models is a 400, not a no-op. Gate every
// temperature on this.
export function modelAcceptsSamplingParams(modelId: string) {
  return !/(sonnet-5|opus-5|opus-4-7|opus-4-8|fable)/.test(modelId);
}

export function embeddingModel() {
  return process.env.BEDROCK_EMBEDDING_MODEL || 'cohere.embed-english-v3';
}

export function rerankModel() {
  return process.env.BEDROCK_RERANK_MODEL || 'cohere.rerank-v3-5:0';
}
