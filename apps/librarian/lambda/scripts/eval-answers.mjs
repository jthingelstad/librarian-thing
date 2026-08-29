#!/usr/bin/env node
// End-to-end answer-quality eval for the live /chat agent loop. Signs in like
// a real reader (magic sign-in code fetched from Fastmail over JMAP), asks
// eight archetype questions against production, grades each answer with the
// fast Bedrock model, and deletes every conversation it created so nothing
// lands in Jamie's conversation rail.
//
//   LIBRARIAN_API_URL=... LIBRARIAN_STREAM_URL=... FASTMAIL_JMAP_TOKEN=... \
//     node scripts/eval-answers.mjs
//
// Optional: EVAL_EMAIL (default jamie@thingelstad.com), THINGY_FAST_MODEL.
// This sends a real sign-in email and burns real chat rate limit - run it
// deliberately, not in a loop. CI runs it weekly via answer-eval.yml.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const apiUrl = String(process.env.LIBRARIAN_API_URL || '').replace(/\/$/, '');
const streamUrl = String(process.env.LIBRARIAN_STREAM_URL || '').replace(/\/$/, '');
const jmapToken = process.env.FASTMAIL_JMAP_TOKEN || '';
const evalEmail = process.env.EVAL_EMAIL || 'jamie@thingelstad.com';
const graderModelId = process.env.THINGY_FAST_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

if (!apiUrl || !streamUrl || !jmapToken) {
  console.error('eval-answers: set LIBRARIAN_API_URL, LIBRARIAN_STREAM_URL, and FASTMAIL_JMAP_TOKEN (see repo .env).');
  process.exit(2);
}

// Eight archetypes the agent loop must keep handling well. `contains` is a
// deterministic must-pass check on the answer text; `rubric` steers the
// model grader beyond generic answer quality.
const QUESTIONS = [
  {
    id: 'synthesis',
    question: 'What does Jamie believe about data ownership?',
    rubric: 'A good answer synthesizes a consistent position across sources, not a single quote or a list of links.'
  },
  {
    id: 'temporal',
    question: 'How has Jamie thinking about remote work evolved over the years?',
    rubric: 'A good answer traces change over time with at least two distinct periods or turning points.'
  },
  {
    id: 'quote',
    question: 'Where did Jamie write "my words are mine"? Quote the passage.',
    rubric: 'The answer must locate the exact phrase and cite Weekly Thing issue WT348 as its source.',
    contains: 'WT348'
  },
  {
    id: 'aggregation',
    question: 'Which year did Jamie write about cryptocurrency the most?',
    rubric: 'The answer must name 2021 as the peak year, ideally with a sense of how the volume compared.',
    contains: '2021'
  },
  {
    id: 'absence',
    question: 'What has Jamie written about running Linux on the desktop?',
    rubric:
      'A good answer honestly says the archive has little or nothing on desktop Linux rather than fabricating coverage.'
  },
  {
    id: 'photos',
    question: 'Show me photos from bike rides along Minnehaha Creek.',
    rubric: 'The answer must include at least one actual image (markdown image syntax), not just describe photos.',
    contains: '!['
  },
  {
    id: 'reading',
    question: 'What books did Jamie read in 2023?',
    rubric: 'A good answer names specific books tied to 2023, drawn from the reading history in the archive.'
  },
  {
    id: 'references',
    question: 'Who does Jamie cite or link to most often?',
    rubric: 'A good answer names specific people or sources with a sense of ranking, not vague categories.'
  }
];

async function apiPost(path, payload, token = '') {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${data.error || data.message || 'error'}`);
  return data;
}

async function jmapFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${jmapToken}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {})
    }
  });
  if (!response.ok) throw new Error(`JMAP HTTP ${response.status}`);
  return await response.json();
}

// Newest "Thingy is ready for you" email received since `since`, mined for
// the six-digit sign-in code that rides in the body alongside the link.
async function latestSignInCodeSince(since) {
  const session = await jmapFetch('https://api.fastmail.com/jmap/session');
  const mail = 'urn:ietf:params:jmap:mail';
  const core = 'urn:ietf:params:jmap:core';
  const accountId = session.primaryAccounts?.[mail];
  const response = await jmapFetch(session.apiUrl, {
    method: 'POST',
    body: JSON.stringify({
      using: [core, mail],
      methodCalls: [
        [
          'Email/query',
          {
            accountId,
            filter: { subject: 'Thingy is ready for you' },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: 8
          },
          'q'
        ],
        [
          'Email/get',
          {
            accountId,
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['subject', 'receivedAt', 'bodyValues'],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes: 200000
          },
          'g'
        ]
      ]
    })
  });
  const emails = response.methodResponses?.find((item) => item[2] === 'g')?.[1]?.list || [];
  for (const item of emails) {
    if (new Date(item.receivedAt || 0) < since) continue;
    const body = Object.values(item.bodyValues || {})
      .map((value) => value?.value || '')
      .join('\n');
    const code = body.match(/sign-in code is (\d{6})/)?.[1];
    if (code) return code;
  }
  return null;
}

async function signIn() {
  const requestedAt = new Date(Date.now() - 5000);
  const request = await apiPost('/auth', { action: 'check', email: evalEmail, source: 'thingy' });
  if (request.status !== 'magic_link_sent') throw new Error(`Unexpected auth status: ${request.status || 'none'}`);

  let code = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    code = await latestSignInCodeSince(requestedAt);
    if (code) break;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (!code) throw new Error('No fresh Thingy sign-in code email found.');

  const verified = await apiPost('/auth', { action: 'verify_code', email: evalEmail, code });
  if (!verified.token) throw new Error('verify_code did not return a session token.');
  return verified.token;
}

// POST /chat and consume the SSE stream: status events name the tools the
// agent ran, answer_delta accumulates prose, answer is the final text, meta
// carries the server-assigned conversation id.
async function askChat(token, question) {
  const started = performance.now();
  const response = await fetch(`${streamUrl}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ message: question, scope: 'all' }),
    signal: AbortSignal.timeout(320000)
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`/chat HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = { answer: '', tools: [], conversationId: '', error: '' };
  let deltas = '';
  let buffer = '';
  const decoder = new TextDecoder();
  const handleFrame = (frame) => {
    const eventName = frame.match(/^event: (.+)$/m)?.[1];
    const dataLine = frame.match(/^data: (.+)$/m)?.[1];
    if (!eventName || !dataLine) return;
    let data = {};
    try {
      data = JSON.parse(dataLine);
    } catch {
      return;
    }
    if (eventName === 'status' && data.tool_name) result.tools.push(String(data.tool_name));
    if (eventName === 'answer_delta') deltas += String(data.delta || '');
    if (eventName === 'answer') result.answer = String(data.answer || '');
    if (eventName === 'meta' && data.conversation_id) result.conversationId = String(data.conversation_id);
    if (eventName === 'error') result.error = String(data.error || 'unknown stream error');
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      handleFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  if (!result.answer) result.answer = deltas;
  result.seconds = (performance.now() - started) / 1000;
  if (result.error) throw new Error(`stream error: ${result.error}`);
  if (!result.answer) throw new Error('stream produced no answer');
  return result;
}

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function gradeAnswer(entry, answer) {
  const prompt = [
    'You grade answers from an archive Q&A assistant over Jamie Thingelstad’s Weekly Thing newsletter, blog, and podcast.',
    'Grade the answer below against the question and rubric. Score 1-5 (5 = excellent, 3 = acceptable, 1 = wrong or empty).',
    'Respond with STRICT JSON only, no prose, no code fences: {"score": <1-5>, "pass": <true|false>, "reason": "<one sentence>"}',
    'pass is true when the answer satisfies the rubric.',
    '',
    `Question: ${entry.question}`,
    `Rubric: ${entry.rubric}`,
    '',
    'Answer:',
    answer
  ].join('\n');
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: graderModelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 300, temperature: 0 }
    })
  );
  const text = (response.output?.message?.content || [])
    .map((block) => block.text || '')
    .join('')
    .trim();
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`grader returned no JSON: ${text.slice(0, 120)}`);
  const grade = JSON.parse(json);
  const score = Number(grade.score);
  if (!Number.isFinite(score) || score < 1 || score > 5)
    throw new Error(`grader score out of range: ${text.slice(0, 120)}`);
  return { score, pass: Boolean(grade.pass), reason: String(grade.reason || '') };
}

const results = [];
const conversationIds = new Set();
let token = '';
let fatal = null;

try {
  console.log(`Signing in as ${evalEmail}...`);
  token = await signIn();
  console.log('Session token acquired.\n');

  for (const entry of QUESTIONS) {
    const row = { id: entry.id, tools: [], toolCount: 0, seconds: 0, deterministicOk: true, grade: null, error: '' };
    results.push(row);
    try {
      const chat = await askChat(token, entry.question);
      if (chat.conversationId) conversationIds.add(chat.conversationId);
      row.tools = chat.tools;
      row.toolCount = chat.tools.length;
      row.seconds = chat.seconds;
      row.answer = chat.answer;
      if (entry.contains) row.deterministicOk = chat.answer.includes(entry.contains);
      try {
        row.grade = await gradeAnswer(entry, chat.answer);
      } catch (error) {
        row.grade = { score: 0, pass: false, reason: `grader failed: ${error.message}` };
      }
    } catch (error) {
      row.error = error.message;
      if (entry.contains) row.deterministicOk = false;
      row.grade = { score: 0, pass: false, reason: `chat failed: ${error.message}` };
    }
    const grade = row.grade || { score: 0, reason: '' };
    console.log(
      `${row.error || (entry.contains && !row.deterministicOk) || grade.score < 3 ? 'FAIL' : 'PASS'}  ${entry.id.padEnd(12)} ` +
        `score=${grade.score}  det=${entry.contains ? (row.deterministicOk ? 'ok' : `missing ${JSON.stringify(entry.contains)}`) : '-'}  ` +
        `tools=${row.toolCount} [${row.tools.join(', ')}]  ${row.seconds.toFixed(1)}s` +
        (grade.reason ? `\n      ${grade.reason.slice(0, 160)}` : '') +
        (row.error ? `\n      error: ${row.error.slice(0, 160)}` : '')
    );
  }
} catch (error) {
  fatal = error;
  console.error(`\neval-answers fatal: ${error.message}`);
} finally {
  // Never leave eval conversations in Jamie's rail, even on a failed run.
  for (const conversationId of conversationIds) {
    try {
      await apiPost('/conversations', { action: 'delete', conversation_id: conversationId }, token);
    } catch (error) {
      console.error(`cleanup: failed to delete conversation ${conversationId}: ${error.message}`);
    }
  }
  if (conversationIds.size) console.log(`\nDeleted ${conversationIds.size} eval conversation(s).`);
}

if (fatal) process.exit(1);

const deterministicFailures = results.filter((row) => !row.deterministicOk).length;
const lowScores = results.filter((row) => (row.grade?.score ?? 0) < 3).length;
const scored = results.map((row) => row.grade?.score ?? 0);
const total = scored.reduce((sum, value) => sum + value, 0);
console.log(
  `\n${results.length} questions | total score ${total}/${results.length * 5} | ` +
    `${lowScores} below 3 | ${deterministicFailures} deterministic failure(s)`
);

process.exit(deterministicFailures > 0 || lowScores > 2 ? 1 : 0);
