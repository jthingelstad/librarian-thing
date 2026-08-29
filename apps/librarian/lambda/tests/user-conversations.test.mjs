import assert from 'node:assert/strict';
import test from 'node:test';
import { loadUserConversationSummaries } from '../dist/shared/conversation-store.mjs';
import {
  artifactDynamoString,
  artifactJsonForStorage,
  conversationSummaryFromItem,
  conversationTitle,
  conversationTurnFromItem,
  fromDynamoAttr,
  historyFromTurns,
  messagesFromTurns,
  toolTraceDynamoString,
  turnSk,
  turnSkPrefix,
  userConversationPk,
  validConversationId
} from '../dist/shared/user-conversations.mjs';

test('fromDynamoAttr unmarshals the attribute types canonical conversation rows use', () => {
  assert.equal(fromDynamoAttr({ S: 'hello' }), 'hello');
  assert.equal(fromDynamoAttr({ N: '42' }), 42);
  assert.equal(fromDynamoAttr({ BOOL: true }), true);
  assert.equal(fromDynamoAttr({ NULL: true }), null);
  assert.deepEqual(fromDynamoAttr({ L: [{ S: '12' }, { S: '13' }] }), ['12', '13']);
  assert.deepEqual(fromDynamoAttr({ M: { issue_number: { S: '247' }, subject: { S: 'A subject' } } }), {
    issue_number: '247',
    subject: 'A subject'
  });
  assert.equal(fromDynamoAttr(null), null);
  assert.equal(fromDynamoAttr('raw'), null);
});

test('conversation key helpers namespace records by user and conversation', () => {
  assert.equal(userConversationPk('abc'), 'user#abc');
  assert.equal(turnSkPrefix('c1'), 'turn#c1#');
  assert.equal(turnSk('c1', '2026-06-06T01:02:03.000Z', 'r1'), 'turn#c1#2026-06-06T01:02:03.000Z#r1');
  assert.equal(validConversationId('c_abc-123.def:456'), 'c_abc-123.def:456');
  assert.equal(validConversationId('../bad'), '');
});

test('conversationTitle compacts and caps first question', () => {
  assert.equal(conversationTitle('  What   did Jamie write about RSS?  '), 'What did Jamie write about RSS?');
  assert.equal(conversationTitle(''), 'Untitled chat');
  assert.equal(conversationTitle('x'.repeat(100)).length, 80);
});

test('conversationSummaryFromItem unmarshals metadata rows', () => {
  const row = conversationSummaryFromItem({
    sk: { S: 'conversation#c1' },
    title: { S: 'A topic' },
    title_source: { S: 'auto' },
    preview: { S: 'Question preview' },
    summary: { S: 'Summary text' },
    topic: { S: 'RSS' },
    tags: { L: [{ S: 'rss' }, { S: 'indieweb' }] },
    scope: { S: 'blog' },
    created_at: { S: '2026-06-06T01:00:00.000Z' },
    updated_at: { S: '2026-06-06T01:03:00.000Z' },
    turn_count: { N: '2' },
    eval_status: { S: 'reviewed' },
    eval_quality: { S: 'clean' },
    eval_flags: { L: [{ S: 'reader_delight' }] },
    eval_improvements: { L: [{ S: 'Keep doing this.' }] },
    eval_last_request_id: { S: 'r2' },
    eval_reader: { S: 'Reader explored RSS.' }
  });
  assert.deepEqual(row, {
    id: 'c1',
    conversation_id: 'c1',
    title: 'A topic',
    title_source: 'auto',
    preview: 'Question preview',
    summary: 'Summary text',
    topic: 'RSS',
    tags: ['rss', 'indieweb'],
    scope: 'blog',
    mode: 'thingy',
    created_at: '2026-06-06T01:00:00.000Z',
    updated_at: '2026-06-06T01:03:00.000Z',
    last_message_at: '2026-06-06T01:03:00.000Z',
    last_request_id: '',
    turn_count: 2,
    eval_status: 'reviewed',
    eval_quality: 'clean',
    eval_flags: ['reader_delight'],
    eval_improvements: ['Keep doing this.'],
    eval_assessed_at: '',
    eval_model: '',
    eval_last_request_id: 'r2',
    eval_topic: '',
    eval_reader: 'Reader explored RSS.',
    eval_thingy: '',
    eval_takeaway: ''
  });
});

test('conversationSummaryFromItem prefers eval topic for generated titles', () => {
  assert.equal(
    conversationSummaryFromItem({
      sk: { S: 'conversation#c1' },
      title: { S: 'Tell me about Hector Fernandez.' },
      title_source: { S: 'auto' },
      eval_topic: { S: 'Who is Hector Fernandez' }
    }).title,
    'Who is Hector Fernandez'
  );

  assert.equal(
    conversationSummaryFromItem({
      sk: { S: 'conversation#c2' },
      title: { S: 'My custom title' },
      title_source: { S: 'user' },
      eval_topic: { S: 'Evaluator topic' }
    }).title,
    'My custom title'
  );
});

test('loadUserConversationSummaries returns up to the account overview limit', async () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    sk: { S: `conversation#c${index}` },
    conversation_id: { S: `c${index}` },
    title: { S: `Conversation ${index}` },
    updated_at: { S: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` },
    turn_count: { N: '1' }
  }));
  const dynamodb = {
    async send(command) {
      assert.equal(command.constructor.name, 'QueryCommand');
      return { Items: items };
    }
  };

  const summaries = await loadUserConversationSummaries({
    dynamodb,
    tableName: 'table-name',
    subscriberHash: 'subscriber-hash',
    limit: 50
  });

  assert.equal(summaries.length, 30);
  assert.equal(summaries[0].id, 'c29');
});

test('turns expand into messages and compact history', () => {
  const turn = conversationTurnFromItem({
    conversation_id: { S: 'c1' },
    request_id: { S: 'r1' },
    created_at: { S: '2026-06-06T01:00:00.000Z' },
    scope: { S: 'all' },
    question: { S: 'Question?' },
    answer: { S: 'Answer.' },
    citations: { L: [{ M: { subject: { S: 'Source' } } }] },
    feedback_reaction: { S: 'down' },
    feedback_comment: { S: 'Missed the obvious source.' },
    tool_names: { L: [{ S: 'archive_lens' }] },
    tool_trace_json: toolTraceDynamoString({ calls: [{ name: 'archive_lens', ok: true }] })
  });
  assert.equal(turn.request_id, 'r1');
  assert.equal(turn.citations[0].subject, 'Source');
  assert.equal(turn.feedback_reaction, 'down');
  assert.equal(turn.feedback_comment, 'Missed the obvious source.');
  assert.deepEqual(turn.tool_names, ['archive_lens']);
  assert.equal(turn.tool_trace.calls[0].name, 'archive_lens');
  assert.deepEqual(
    messagesFromTurns([turn]).map((item) => item.role),
    ['user', 'assistant']
  );
  assert.deepEqual(messagesFromTurns([turn])[1].tool_names, ['archive_lens']);
  assert.deepEqual(historyFromTurns([turn]), [
    { role: 'user', content: 'Question?' },
    { role: 'assistant', content: 'Answer.' }
  ]);
});

test('artifact-only turns expand into assistant artifact messages', () => {
  // Curiosity maps were retired 2026-08-29, but historical Dynamo rows still
  // carry artifact_json; the read path must keep parsing them (the client
  // hides artifact-only messages).
  const artifact = {
    kind: 'curiosity_map',
    title: 'Curiosity Map: RSS',
    nodes: [{ id: 'rss', label: 'RSS', kind: 'center' }],
    edges: []
  };
  const turn = conversationTurnFromItem({
    conversation_id: { S: 'c-map' },
    request_id: { S: 'r-map' },
    created_at: { S: '2026-06-06T02:00:00.000Z' },
    scope: { S: 'all' },
    question: { S: '' },
    answer: { S: '' },
    artifact_json: artifactDynamoString(artifact)
  });
  assert.equal(turn.artifact.title, 'Curiosity Map: RSS');
  assert.deepEqual(messagesFromTurns([turn]), [
    {
      role: 'assistant',
      content: '',
      citations: [],
      created_at: '2026-06-06T02:00:00.000Z',
      request_id: 'r-map',
      artifact,
      tool_names: []
    }
  ]);
  assert.deepEqual(historyFromTurns([turn]), []);
});

test('oversized artifacts are compacted without corrupting JSON', () => {
  const artifact = {
    kind: 'curiosity_map',
    title: 'Curiosity Map: Long',
    center: { id: 'long', label: 'Long', kind: 'center', prompt: 'Build a long map.', why: 'Large fixture.' },
    nodes: Array.from({ length: 40 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      kind: 'archive',
      prompt: `Trace a very long prompt ${index} ${'x'.repeat(800)}`,
      why: `A very long reason ${index} ${'y'.repeat(800)}`,
      source_refs: [{ title: `Source ${index}`, url: `https://example.com/${index}`, reason: 'Fixture' }]
    })),
    edges: Array.from({ length: 40 }, (_, index) => ({ from: 'long', to: `node-${index}`, why: 'Fixture edge' })),
    sources: Array.from({ length: 20 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.com/${index}`
    })),
    prompt: 'Follow this huge map.'
  };
  const json = artifactJsonForStorage(artifact);
  assert.ok(json.length <= 20000);
  const parsed = JSON.parse(json);
  assert.equal(parsed.compacted, true);

  const turn = conversationTurnFromItem({
    conversation_id: { S: 'c-map' },
    request_id: { S: 'r-map' },
    created_at: { S: '2026-06-06T02:00:00.000Z' },
    artifact_json: artifactDynamoString(artifact)
  });
  assert.ok(turn.artifact);
});
