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
export const DEFAULT_THINGY_MODEL = 'claude-sonnet-5-5';
export const FAST_THINGY_MODEL = 'claude-haiku-5-5';
// Supporters and the owner get the Opus tier (Jamie's call, 2026-09-02).
// THINGY_ADVANCED_MODEL, the old third slot, was a Dispatch-era artifact
// that no code path ever invoked; premium replaces it with a real route.
export const PREMIUM_THINGY_MODEL = 'claude-opus-5-5';

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

// Sampling parameters (temperature, top_p, top_k) are an allowlist of the
// older generations that still take them: Claude 3, Haiku 4.5, and Sonnet and
// Opus 4 through 4.6. The Claude 5 family (Haiku 5.5 included), Opus 4.7/4.8
// and Fable return a 400 for them, and an id not named here is treated the
// same way, so a new model never gets a temperature by accident. Gate every
// temperature on this.
const SAMPLING_MODEL_RE = /claude-3|haiku-4-5|(?:sonnet|opus)-4(?:-[0-6])?(?:-\d{8}|-v\d|$)/;

export function modelAcceptsSamplingParams(modelId: string) {
  return SAMPLING_MODEL_RE.test(String(modelId || ''));
}

// Sonnet 5.5, Opus 5.5 and Fable 5.1 always think, take an effort level, and
// return the notes they write between tool calls as thinking blocks
// (chat/runtime.mts asks for those notes back). Older models get none of it.
export function modelWritesProgressUpdates(modelId: string) {
  return /(sonnet-5-5|opus-5-5|fable-5-1)/.test(modelId);
}

export function embeddingModel() {
  return process.env.BEDROCK_EMBEDDING_MODEL || 'cohere.embed-english-v3';
}

export function rerankModel() {
  return process.env.BEDROCK_RERANK_MODEL || 'cohere.rerank-v3-5:0';
}
