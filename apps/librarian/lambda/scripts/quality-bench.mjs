// Thingy quality bench: grounded archive Q&A against the models Thingy
// runs on. Each run pulls real passages from the live /retrieve endpoint
// (read-only, service-auth) and answers a fixed question set via Bedrock
// Converse - producing (1) a durable record of answer quality per model,
// ready for before/after comparison when the model roster changes, and
// (2) legitimate Bedrock usage on the account (AWS gates the newest
// model generation on usage history; see memory/thingy-model-tiers).
//
// Usage:
//   AWS_PROFILE=jamie node scripts/quality-bench.mjs [--questions N] [--opus N]
// Results: ~/.local/share/thingy-bench/bench-<date>.jsonl
// Cost: roughly $1.50 per default run (30 Sonnet + 5 Opus answers).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const RETRIEVE_URL = process.env.LIBRARIAN_RETRIEVE_URL || 'https://librarian.thingelstad.com/retrieve';
const DEFAULT_MODEL = process.env.BENCH_DEFAULT_MODEL || 'us.anthropic.claude-sonnet-4-6';
const PREMIUM_MODEL = process.env.BENCH_PREMIUM_MODEL || 'us.anthropic.claude-opus-4-6-v1';
const MAX_TOKENS = 1200;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? Number(process.argv[index + 1]) : fallback;
}

function retrieveSecret() {
  if (process.env.LIBRARIAN_RETRIEVE_SECRET) return process.env.LIBRARIAN_RETRIEVE_SECRET;
  const envPath = path.resolve(import.meta.dirname, '../../../../.env');
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const match = /^LIBRARIAN_RETRIEVE_SECRET=(.+)$/m.exec(text);
  if (!match) throw new Error('LIBRARIAN_RETRIEVE_SECRET not found (env or repo .env)');
  return match[1].trim().replace(/^"|"$/g, '');
}

async function retrievePassages(secret, query) {
  const response = await fetch(RETRIEVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, k: 8, retrieve_secret: secret })
  });
  if (!response.ok) throw new Error(`retrieve ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.passages) ? data.passages : [];
}

function groundedPrompt(question, passages) {
  const sources = passages
    .map((p, i) => `[${i + 1}] ${p.title || p.subject || ''} (${p.publish_date || 'n.d.'})\n${p.label || ''}`)
    .join('\n\n');
  return [
    "You are Thingy, the archive librarian for Jamie Thingelstad's published writing.",
    'Answer the question using ONLY the archive passages below. Cite Weekly Thing sources as #NNN when an issue number is evident; cite blog and podcast sources by title. If the passages do not answer the question, say so plainly.',
    '',
    `Archive passages:\n${sources}`,
    '',
    `Question: ${question}`
  ].join('\n');
}

async function answer(bedrock, modelId, prompt) {
  const start = Date.now();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0.45 }
    })
  );
  const text = (response.output?.message?.content || []).map((block) => block.text || '').join('');
  return {
    text,
    usage: response.usage || {},
    duration_ms: Date.now() - start
  };
}

const questions = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'bench-questions.json'), 'utf8'));
const questionCount = Math.min(arg('questions', 30), questions.length);
const opusCount = Math.min(arg('opus', 5), questionCount);
const secret = retrieveSecret();
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

const outDir = path.join(os.homedir(), '.local', 'share', 'thingy-bench');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `bench-${new Date().toISOString().slice(0, 10)}.jsonl`);
const out = fs.createWriteStream(outFile, { flags: 'a' });

const totals = { calls: 0, input: 0, output: 0, errors: 0 };
for (const [index, question] of questions.slice(0, questionCount).entries()) {
  const models = index < opusCount ? [DEFAULT_MODEL, PREMIUM_MODEL] : [DEFAULT_MODEL];
  try {
    const passages = await retrievePassages(secret, question);
    for (const modelId of models) {
      const result = await answer(bedrock, modelId, groundedPrompt(question, passages));
      totals.calls += 1;
      totals.input += Number(result.usage.inputTokens || 0);
      totals.output += Number(result.usage.outputTokens || 0);
      out.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          question,
          model: modelId,
          passages: passages.length,
          answer: result.text,
          usage: result.usage,
          duration_ms: result.duration_ms
        })}\n`
      );
      process.stdout.write(
        `${String(index + 1).padStart(2)} ${modelId.includes('opus') ? 'opus  ' : 'sonnet'} ${result.duration_ms}ms ${result.usage.outputTokens || 0} out\n`
      );
    }
  } catch (error) {
    totals.errors += 1;
    process.stdout.write(`${String(index + 1).padStart(2)} ERROR ${error.message}\n`);
  }
}
out.end();
// Sonnet 4.6 $3/$15 per MTok as the cost yardstick; Opus share is small.
const estCost = (totals.input * 3 + totals.output * 15) / 1e6;
console.log(
  `\nbench done: ${totals.calls} answers, ${totals.errors} errors, ` +
    `${totals.input.toLocaleString()} in / ${totals.output.toLocaleString()} out tokens, ~$${estCost.toFixed(2)} (sonnet-rate est)\n${outFile}`
);
