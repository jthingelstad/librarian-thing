import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQueuedDispatch,
  deleteUserDispatch,
  dispatchAvailabilityFromRows,
  dispatchForClient,
  dispatchIsActive,
  getUserDispatch,
  recoverStaleDispatches,
  upsertDispatchDraft
} from '../dist/shared/dispatch-store.mjs';
import { dispatchContentArtifactKey } from '../dist/shared/dispatch-artifacts.mjs';
import {
  analyzeDispatchSourceFit,
  dispatchHtmlEmail,
  dispatchSubject,
  dispatchTextEmail,
  dispatchTemplateTestPayload,
  parseDispatchJson,
  selectDispatchSources
} from '../dist/shared/dispatch-generator.mjs';

test('dispatch availability enforces active and rolling 24-hour limits', () => {
  const nowSeconds = Math.floor(Date.parse('2026-06-08T12:00:00Z') / 1000);
  assert.deepEqual(dispatchAvailabilityFromRows([{ id: 'd1', status: 'queued' }], { nowSeconds }), {
    allowed: false,
    reason: 'active',
    message: 'A Dispatch is already being prepared. Wait for that one to finish before starting another.',
    active_dispatch_id: 'd1'
  });

  const limited = dispatchAvailabilityFromRows([{ id: 'd2', status: 'sent', sent_at: '2026-06-08T00:00:00Z' }], {
    nowSeconds
  });
  assert.equal(limited.allowed, false);
  assert.equal(limited.reason, 'cooldown');
  assert.equal(limited.retry_after_seconds, 43200);

  assert.equal(
    dispatchAvailabilityFromRows([{ id: 'd2', status: 'sent', sent_at: '2026-06-08T00:00:00Z' }], {
      nowSeconds,
      owner: true
    }).allowed,
    true
  );

  assert.equal(dispatchAvailabilityFromRows([{ id: 'd3', status: 'ready' }], { nowSeconds }).allowed, true);
});
test('dispatch availability ignores stale leased and unclaimed queued active rows', () => {
  const nowSeconds = Math.floor(Date.parse('2026-06-08T12:00:00Z') / 1000);
  const staleQueued = {
    id: 'd0',
    status: 'queued',
    queued_at: '2026-06-08T11:40:00Z'
  };
  const freshQueued = {
    id: 'd0b',
    status: 'queued',
    queued_at: '2026-06-08T11:55:00Z'
  };
  const staleGenerating = {
    id: 'd1',
    status: 'generating',
    lease_expires_at: '2026-06-08T11:50:00Z'
  };
  const freshGenerating = {
    id: 'd2',
    status: 'generating',
    lease_expires_at: '2026-06-08T12:05:00Z'
  };

  assert.equal(dispatchIsActive(staleQueued, { nowSeconds }), false);
  assert.equal(dispatchIsActive(freshQueued, { nowSeconds }), true);
  assert.equal(dispatchIsActive(staleGenerating, { nowSeconds }), false);
  assert.equal(dispatchIsActive(freshGenerating, { nowSeconds }), true);
  assert.equal(dispatchAvailabilityFromRows([staleQueued], { nowSeconds }).allowed, true);
  assert.equal(dispatchAvailabilityFromRows([freshQueued], { nowSeconds }).allowed, false);
  assert.equal(dispatchAvailabilityFromRows([staleGenerating], { nowSeconds }).allowed, true);
  assert.equal(dispatchAvailabilityFromRows([freshGenerating], { nowSeconds }).allowed, false);
});

test('dispatchForClient includes draft state but omits generated content', () => {
  const client = dispatchForClient({
    pk: { S: 'user#abc' },
    sk: { S: 'dispatch#2026-06-08T12:00:00.000Z#d1' },
    dispatch_id: { S: 'd1' },
    status: { S: 'ready' },
    prompt: { S: 'Explore the open web' },
    direction: { S: 'Write about ownership and RSS.' },
    clarification_question: { S: 'What angle?' },
    clarification_answer: { S: 'The personal web.' },
    title: { S: 'Open web Dispatch' },
    brief_json: { S: JSON.stringify({ coverage_status: 'focused', working_angle: 'RSS as ownership infrastructure' }) },
    template_test: { BOOL: true },
    messages: {
      L: [
        {
          M: {
            role: { S: 'user' },
            text: { S: 'Open web please' },
            time: { S: '2026-06-08T12:00:00.000Z' }
          }
        }
      ]
    },
    content_artifact_bucket: { S: 'private-bucket' },
    content_artifact_key: { S: 'artifacts/dispatches/abc/d1.json' },
    content_html: { S: '<p>private</p>' },
    content_text: { S: 'private' }
  });
  assert.equal(client.id, 'd1');
  assert.equal(client.status, 'ready');
  assert.equal(client.prompt, 'Explore the open web');
  assert.equal(client.template_test, true);
  assert.equal(client.brief.coverage_status, 'focused');
  assert.equal(client.brief.working_angle, 'RSS as ownership infrastructure');
  assert.equal(client.messages.length, 1);
  assert.equal(client.content_artifact_bucket, undefined);
  assert.equal(client.content_artifact_key, undefined);
  assert.equal(client.content_html, undefined);
  assert.equal(client.content_text, undefined);
});

test('dispatch content artifact keys are scoped and filesystem-safe', () => {
  assert.equal(
    dispatchContentArtifactKey({ subscriberHash: 'abc/../def', dispatchId: 'dispatch#1?' }),
    'artifacts/dispatches/abc_.._def/dispatch_1_.json'
  );
});

test('dispatches are addressable by id lookup rows', async () => {
  const items = new Map();
  const dynamodb = {
    async send(command) {
      const input = command.input || {};
      const key = input.Key ? `${input.Key.pk.S}\0${input.Key.sk.S}` : '';
      if (command.constructor.name === 'PutItemCommand') {
        items.set(`${input.Item.pk.S}\0${input.Item.sk.S}`, input.Item);
        return {};
      }
      if (command.constructor.name === 'GetItemCommand') {
        return { Item: items.get(key) };
      }
      if (command.constructor.name === 'DeleteItemCommand') {
        items.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };

  const created = await createQueuedDispatch({
    dynamodb,
    tableName: 'table',
    subscriberHash: 'reader-hash',
    emailHash: 'reader-hash',
    toEmail: 'reader@example.com',
    topic: 'RSS',
    prompt: 'Explore RSS',
    direction: 'Explore RSS and ownership.',
    dispatchId: 'dispatch-123',
    now: '2026-06-08T12:00:00.000Z'
  });
  assert.equal(created.id, 'dispatch-123');
  assert.equal(created.ttl, 0);

  const queuedItems = [...items.values()];
  assert.equal(queuedItems.length, 2);
  assert.equal(
    queuedItems.some((item) => item.ttl),
    false
  );

  const loaded = await getUserDispatch({
    dynamodb,
    tableName: 'table',
    subscriberHash: 'reader-hash',
    dispatchId: 'dispatch-123'
  });
  assert.equal(loaded.id, 'dispatch-123');
  assert.equal(loaded.topic, 'RSS');

  await deleteUserDispatch({
    dynamodb,
    tableName: 'table',
    subscriberHash: 'reader-hash',
    dispatchId: 'dispatch-123'
  });
  assert.equal(items.size, 0);
});

test('dispatch drafts get short-lived ttl on canonical and lookup rows', async () => {
  const items = new Map();
  const dynamodb = {
    async send(command) {
      const input = command.input || {};
      const key = input.Key ? `${input.Key.pk.S}\0${input.Key.sk.S}` : '';
      if (command.constructor.name === 'PutItemCommand') {
        items.set(`${input.Item.pk.S}\0${input.Item.sk.S}`, input.Item);
        return {};
      }
      if (command.constructor.name === 'GetItemCommand') {
        return { Item: items.get(key) };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };
  const now = '2026-06-08T12:00:00.000Z';
  const expectedTtl = Math.floor(Date.parse(now) / 1000) + 7 * 24 * 60 * 60;

  const draft = await upsertDispatchDraft({
    dynamodb,
    tableName: 'table',
    subscriberHash: 'reader-hash',
    dispatchId: 'dispatch-draft-1',
    prompt: 'Explore RSS',
    brief: {
      coverage_status: 'focused',
      working_angle: 'RSS as ownership infrastructure',
      selected_sources: [{ id: 'S1', label: 'WT10', title: 'Open web', why: 'Primary source' }]
    },
    messages: [
      {
        id: 'archive-fit',
        role: 'assistant',
        kind: 'progress',
        status: 'complete',
        text: 'Checked archive coverage.'
      }
    ],
    now
  });

  assert.equal(draft.id, 'dispatch-draft-1');
  assert.equal(draft.ttl, expectedTtl);
  assert.equal(draft.brief.coverage_status, 'focused');
  assert.equal(draft.brief.selected_sources[0].why, 'Primary source');
  assert.equal(draft.messages[0].id, 'archive-fit');
  assert.equal(draft.messages[0].status, 'complete');
  for (const item of items.values()) {
    assert.equal(Number(item.ttl.N), expectedTtl);
  }
});

test('stale shaping dispatch drafts recover to the implied draft state', async () => {
  const updates = [];
  const dynamodb = {
    async send(command) {
      const input = command.input || {};
      if (command.constructor.name === 'UpdateItemCommand') {
        updates.push(input);
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };

  const recovered = await recoverStaleDispatches({
    dynamodb,
    tableName: 'table',
    subscriberHash: 'reader-hash',
    rows: [
      {
        id: 'dispatch-1',
        status: 'shaping',
        prompt: 'RSS and publishing',
        direction: 'How RSS reading habits feed a creative publishing workflow.',
        created_at: '2026-06-08T12:00:00.000Z',
        updated_at: '2026-06-08T12:00:00.000Z'
      }
    ]
  });

  assert.equal(recovered, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ExpressionAttributeValues[':status'].S, 'ready');
});

test('dispatch template test payload renders placeholder content with real source links', () => {
  const sources = [
    {
      id: 'S1',
      label: 'WT10',
      title: 'Open web',
      url: 'https://weekly.example/10',
      source_kind: 'weekly_thing',
      publish_date: '2026-01-01'
    }
  ];
  const payload = dispatchTemplateTestPayload(
    {
      prompt: 'Explore RSS',
      direction: 'Template-test the Dispatch email around RSS and ownership.'
    },
    sources
  );
  const html = dispatchHtmlEmail(payload, sources);

  assert.equal(payload.subject, 'Thingy Dispatch — Template-test the Dispatch email around RSS and ownership.');
  assert.equal(payload.title, 'Template-test the Dispatch email around RSS and ownership.');
  assert.match(payload.intro, /intentionally does not contain generated long-form Dispatch writing/);
  assert.match(html, /Thingy Dispatch/);
  assert.match(html, /template test/i);
  assert.match(html, /https:\/\/weekly\.example\/10/);
});

test('selectDispatchSources scores archive chunks and dedupes by url', () => {
  const chunks = [
    {
      source_kind: 'weekly_thing',
      issue_number: 10,
      title: 'Open web',
      url: 'https://weekly.example/10',
      text: 'RSS and open web ownership matter.'
    },
    {
      source_kind: 'blog',
      title: 'Owning your notes',
      url: 'https://blog.example/notes',
      text: 'Personal ownership and automation with notes.'
    },
    {
      source_kind: 'blog',
      title: 'Duplicate',
      url: 'https://blog.example/notes',
      text: 'ownership ownership ownership'
    }
  ];
  const selected = selectDispatchSources(chunks, 'open web ownership automation', 3);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].id, 'S1');
  assert.equal(selected[0].label, 'WT10');
  assert.ok(selected.some((source) => source.source_kind === 'blog'));
});

test('analyzeDispatchSourceFit classifies thin and broad Dispatch seeds', () => {
  const chunks = [
    {
      source_kind: 'weekly_thing',
      issue_number: 10,
      title: 'Open web',
      url: 'https://weekly.example/10',
      text: 'RSS and open web ownership matter.'
    },
    {
      source_kind: 'blog',
      title: 'Owning your notes',
      url: 'https://blog.example/notes',
      text: 'Personal ownership and automation with notes.'
    },
    ...Array.from({ length: 36 }, (_, index) => ({
      source_kind: index % 2 ? 'blog' : 'weekly_thing',
      title: `AI note ${index}`,
      url: `https://example.com/ai-${index}`,
      text: `AI automation agents archive source ${index}`
    }))
  ];
  const thin = analyzeDispatchSourceFit(chunks, 'quantum garden party', 6);
  assert.equal(thin.coverage_status, 'thin');
  assert.equal(thin.selected_sources.length, 0);

  const broad = analyzeDispatchSourceFit(chunks, 'AI', 18);
  assert.equal(broad.coverage_status, 'broad');
  assert.ok(broad.candidate_count >= 34);
  assert.ok(broad.selected_sources.length >= 6);
});

test('analyzeDispatchSourceFit rejects broad adjacent matches without direct subject support', () => {
  const chunks = Array.from({ length: 40 }, (_, index) => ({
    source_kind: index % 2 ? 'blog' : 'weekly_thing',
    title: `Travel note ${index}`,
    url: `https://example.com/africa-${index}`,
    text: `Africa travel leadership productivity archive source ${index}.`
  }));

  const fit = analyzeDispatchSourceFit(chunks, 'Biking in Africa', 8);

  assert.equal(fit.coverage_status, 'thin');
  assert.equal(fit.candidate_count, 0);
  assert.equal(fit.selected_sources.length, 0);
});

test('analyzeDispatchSourceFit accepts direct subject support with simple inflections', () => {
  const chunks = Array.from({ length: 5 }, (_, index) => ({
    source_kind: 'blog',
    title: `Bike note ${index}`,
    url: `https://example.com/bike-africa-${index}`,
    text: `A bike trip through African regions and riding infrastructure source ${index}.`
  }));

  const fit = analyzeDispatchSourceFit(chunks, 'Biking in Africa', 8);

  assert.notEqual(fit.coverage_status, 'thin');
  assert.equal(fit.candidate_count, 5);
  assert.ok(fit.selected_sources.length >= 4);
});

test('analyzeDispatchSourceFit ignores generic Dispatch framing words', () => {
  const chunks = [
    {
      source_kind: 'weekly_thing',
      issue_number: 10,
      title: 'Writing and publishing notes',
      url: 'https://weekly.example/10',
      text: 'Jamie writes about publishing, blogging, and owning the archive.'
    },
    {
      source_kind: 'blog',
      title: 'Court notes',
      url: 'https://blog.example/court',
      text: 'A courthouse visit with notes about civic process.'
    }
  ];
  const fit = analyzeDispatchSourceFit(
    chunks,
    "A Dispatch about Jamie's published writing on pickleball strategy and court positioning.",
    6
  );
  assert.equal(fit.coverage_status, 'thin');
  assert.equal(fit.candidate_count, 0);
});

test('parseDispatchJson handles fenced JSON', () => {
  assert.deepEqual(parseDispatchJson('```json\n{"title":"Dispatch"}\n```'), { title: 'Dispatch' });
});

test('dispatchHtmlEmail renders request provenance authorship boundary and linked sources', () => {
  const html = dispatchHtmlEmail(
    {
      title: 'Ownership Dispatch',
      preview: 'A short preview.',
      intro: 'Thingy found a *thread* [S1].',
      sections: [{ heading: 'The thread', body: 'This depends on **ownership** and [S1].' }],
      closing: 'Keep exploring.',
      followups: ['What changed over time?']
    },
    [
      {
        id: 'S1',
        label: 'WT10',
        title: 'Open web',
        url: 'https://weekly.example/10',
        source_kind: 'weekly_thing',
        publish_date: '2026-01-01'
      }
    ],
    {
      dispatchId: 'dispatch-123',
      toEmail: 'reader@example.com',
      requestedAt: '2026-06-08T12:00:00.000Z',
      requestSummary: 'Explore ownership and the open web from the archive.'
    }
  );
  assert.match(html, /Thingy Dispatch/);
  assert.match(html, /requested by reader@example\.com on 2026-06-08 12:00Z/);
  assert.match(html, /<strong[^>]*>Request<\/strong>Explore ownership and the open web from the archive\./);
  assert.doesNotMatch(html, />Requested</);
  assert.doesNotMatch(html, />Attribution</);
  assert.match(html, /<em>thread<\/em>/);
  assert.match(html, /<strong>ownership<\/strong>/);
  assert.match(html, /href="https:\/\/thingy\.thingelstad\.com\/"/);
  assert.match(html, /Written by Thingy, not Jamie/);
  assert.match(html, /https:\/\/weekly\.example\/10/);
  assert.match(
    html,
    /https:\/\/tinylytics\.app\/pixel\/u5bRAyyJvMXUrz6zbTz5\.gif\?path=%2Femail%2Fthingy%2Fdispatch%2Fdispatch-123/
  );
  assert.match(html, /href="#source-S1"[^>]*>1<\/a>/);
  assert.match(html, /id="source-S1"/);
  assert.doesNotMatch(html, /<strong>S1<\/strong>/);
  assert.doesNotMatch(html, /\(2026-01-01\)/);
});

test('dispatch email rendering preserves paragraph breaks and normalizes subject prefix', () => {
  const payload = dispatchTemplateTestPayload(
    {
      prompt: 'Explore RSS',
      direction: 'RSS and ownership'
    },
    []
  );
  const html = dispatchHtmlEmail(
    {
      ...payload,
      subject: 'A custom generated title',
      intro: 'First paragraph has useful setup.\n\nSecond paragraph should not be eaten.',
      sections: [
        {
          heading: 'The thread',
          body: 'Sentence one. Sentence two should not run into sentence three. Sentence three keeps breathing room.'
        }
      ]
    },
    [],
    {
      toEmail: 'reader@example.com',
      requestedAt: '2026-06-08T12:00:00.000Z'
    }
  );
  const text = dispatchTextEmail(payload, [], {
    toEmail: 'reader@example.com',
    requestedAt: '2026-06-08T12:00:00.000Z',
    requestSummary: 'RSS and ownership'
  });

  assert.equal(payload.subject, 'Thingy Dispatch — RSS and ownership');
  assert.equal(dispatchSubject('Dispatch: Old shape title'), 'Thingy Dispatch — Old shape title');
  assert.match(
    html,
    /display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;">A low-cost Thingy Dispatch template test/
  );
  assert.match(html, /First paragraph has useful setup\./);
  assert.match(html, /Second paragraph should not be eaten\./);
  assert.match(text, /This Thingy Dispatch was requested by reader@example\.com on 2026-06-08 12:00Z\./);
  assert.match(text, /Request: RSS and ownership/);
  assert.match(text, /Prepared by Thingy \(https:\/\/thingy\.thingelstad\.com\/\)/);
});

test('dispatch renderer turns source refs and followups into normal links', () => {
  const html = dispatchHtmlEmail(
    {
      title: 'Home Automation',
      preview: 'A dispatch about coordination.',
      intro:
        'In Weekly Thing 336, Jamie draws a privacy line around smart devices. [S1]\n\nThe blog post "My GTD Structure" maps routine work into a system. [S2]',
      sections: [
        {
          heading: 'Thread',
          body: 'This leans on [S1] when no source title is nearby.'
        }
      ],
      closing: '',
      followups: ['How does this connect to OmniFocus?']
    },
    [
      {
        id: 'S1',
        label: 'WT336',
        title: 'Weekly Thing 336 / Culture, Retention, Transmission',
        url: '/archive/336/',
        source_kind: 'weekly_thing',
        publish_date: '2026-01-01'
      },
      {
        id: 'S2',
        label: 'Blog',
        title: 'My GTD Structure',
        url: 'https://www.thingelstad.com/2024/09/02/my-gtd-structure.html',
        source_kind: 'blog',
        publish_date: '2024-09-02'
      }
    ]
  );

  assert.match(html, /<a href="https:\/\/weekly\.thingelstad\.com\/archive\/336\/"[^>]*>Weekly Thing 336<\/a>/);
  assert.match(
    html,
    /<a href="https:\/\/www\.thingelstad\.com\/2024\/09\/02\/my-gtd-structure\.html"[^>]*>My GTD Structure<\/a>/
  );
  assert.match(
    html,
    /href="https:\/\/thingy\.thingelstad\.com\/chat\/\?prompt=How\+does\+this\+connect\+to\+OmniFocus%3F"/
  );
  assert.doesNotMatch(html, /<strong>S1<\/strong> WT336/);
  assert.doesNotMatch(html, /\(2024-09-02\)/);
});

test('dispatch renderer formats markdown lists and source-only refs as footnotes', () => {
  const html = dispatchHtmlEmail(
    {
      title: 'Crypto Dispatch',
      preview: 'A dispatch about crypto.',
      intro: '',
      sections: [
        {
          heading: 'So What',
          body: [
            'Synthesizing across the archive, Jamie sees crypto as:',
            '',
            '1. A technology that asks important questions about autonomy. [S1]',
            '2. A space plagued by bad actors. [S2]',
            '3. An energy-intensive system whose costs are real.'
          ].join('\n')
        }
      ],
      closing: '',
      followups: []
    },
    [
      {
        id: 'S1',
        label: 'Blog',
        title: 'Polarizing Technology: Encryption and Crypto',
        url: 'https://www.thingelstad.com/2022/12/27/polarizing-technology-encryption.html',
        source_kind: 'blog'
      },
      {
        id: 'S2',
        label: 'WT229',
        title: 'Weekly Thing #229 / Time, Zolatron, Maigret',
        url: '/archive/229/',
        source_kind: 'weekly_thing'
      }
    ]
  );

  assert.match(html, /<ol style="padding-left:24px/);
  assert.match(html, /<li style="margin:0 0 8px;">A technology that asks important questions about autonomy\.<sup/);
  assert.match(html, /href="#source-S1"[^>]*>1<\/a>/);
  assert.match(html, /href="#source-S2"[^>]*>2<\/a>/);
  assert.match(html, /id="source-S1"/);
  assert.match(html, /id="source-S2"/);
  assert.doesNotMatch(html, /<p[^>]*>1\. A technology/);
});

test('dispatch renderer converts markdown blockquotes to email HTML', () => {
  const html = dispatchHtmlEmail(
    {
      title: 'Quoted Dispatch',
      preview: 'A dispatch with a quote.',
      intro: '',
      sections: [
        {
          heading: 'Archive Voice',
          body: [
            'The archive frames the point this way:',
            '',
            '> Privacy is not a feature toggle.',
            '> It is a design constraint with *teeth*. [S1]',
            '',
            'That quote shapes the rest of the Dispatch.'
          ].join('\n')
        }
      ],
      closing: '',
      followups: []
    },
    [
      {
        id: 'S1',
        label: 'Blog',
        title: 'Privacy as Design Constraint',
        url: 'https://www.thingelstad.com/2024/01/01/privacy-design.html',
        source_kind: 'blog'
      }
    ]
  );

  assert.match(html, /<blockquote style="border-left:4px solid #d8e1dd/);
  assert.match(html, /Privacy is not a feature toggle\./);
  assert.match(html, /<em>teeth<\/em>\.<sup/);
  assert.match(html, /href="#source-S1"[^>]*>1<\/a>/);
  assert.doesNotMatch(html, /&gt; Privacy is not/);
  assert.doesNotMatch(html, /> Privacy is not/);
});

test('Dispatch worker treats conditional claim races as idempotent conflicts', async () => {
  const { isConditionalClaimConflict } = await import('../dist/shared/dispatch-worker.mjs');
  const conflict = new Error('already claimed');
  conflict.name = 'ConditionalCheckFailedException';

  assert.equal(isConditionalClaimConflict(conflict), true);
  assert.equal(isConditionalClaimConflict(new Error('JMAP unavailable')), false);
});

test('dispatch planner mode is hidden from pickers but usable by readers', async () => {
  const { availableConversationModes, canUseConversationMode, conversationModePrompt } =
    await import('../dist/shared/conversation-modes.mjs');
  assert.equal(
    availableConversationModes(['reader']).some((mode) => mode.id === 'dispatch'),
    false
  );
  assert.equal(
    availableConversationModes(['reader', 'owner']).some((mode) => mode.id === 'dispatch'),
    false
  );
  assert.equal(canUseConversationMode('dispatch', ['reader']), true);
  const prompt = conversationModePrompt('dispatch');
  assert.match(prompt, /Dispatch Planner/);
  assert.match(prompt, /check_dispatch_fit/);
  assert.match(prompt, /update_dispatch_brief/);
  assert.match(prompt, /Every turn must publish a brief/);
  assert.match(prompt, /explicit source-limited direction/);
  assert.match(prompt, /Never claim generation/);
});

test('update_dispatch_brief normalizes drafts and gates ready briefs on coverage', async () => {
  const { DISPATCH_PLANNER_TOOLS } = await import('../dist/shared/dispatch-planner-tools.mjs');
  const update = DISPATCH_PLANNER_TOOLS.update_dispatch_brief;

  const missing = await update({});
  assert.match(missing.error, /user_goal or working_angle/);

  const draft = await update({
    user_goal: '  A Dispatch about   RSS workflows  ',
    working_angle: 'How RSS shaped owned distribution',
    coverage_status: 'nonsense',
    generation_instructions: 'Trace RSS from early issues to now.',
    selected_sources: [
      { title: 'WT 101', url: 'https://weekly.thingelstad.com/101', why: 'dense RSS issue' },
      { label: '' }
    ],
    status: 'unexpected'
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.brief.user_goal, 'A Dispatch about RSS workflows');
  assert.equal(draft.brief.coverage_status, 'ambiguous');
  assert.equal(draft.brief.status, 'draft');
  assert.equal(draft.brief.selected_sources.length, 1);
  assert.equal(draft.brief.selected_sources[0].id, 'S1');

  const prematureReady = await update({
    user_goal: 'RSS Dispatch',
    working_angle: 'RSS and owned distribution',
    coverage_status: 'broad',
    generation_instructions: 'Write it.',
    status: 'ready'
  });
  assert.match(prematureReady.error, /focused coverage or a curated packet/);
  assert.equal(prematureReady.brief.status, 'ready');

  const curatedBroadReady = await update({
    user_goal: 'RSS Dispatch',
    working_angle: 'RSS and owned distribution',
    coverage_status: 'broad',
    generation_instructions: 'Trace the thread with dates and links.',
    selected_sources: [
      { id: 'S1', title: 'WT 101', url: 'https://weekly.thingelstad.com/101' },
      { id: 'S2', title: 'WT 298', url: 'https://weekly.thingelstad.com/298' }
    ],
    status: 'ready'
  });
  assert.equal(curatedBroadReady.ok, true);
  assert.equal(curatedBroadReady.status, 'ready');
  assert.equal(curatedBroadReady.brief.coverage_status, 'focused');

  const ready = await update({
    user_goal: 'RSS Dispatch',
    working_angle: 'RSS and owned distribution',
    coverage_status: 'focused',
    generation_instructions: 'Trace the thread with dates and links.',
    selected_sources: [{ id: 'S1', title: 'WT 101', url: 'https://weekly.thingelstad.com/101' }],
    status: 'ready'
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'ready');
});

test('dispatch planner tool specs expose both planning tools', async () => {
  const { dispatchPlannerToolSpecs } = await import('../dist/shared/dispatch-planner-tools.mjs');
  const specs = dispatchPlannerToolSpecs();
  const names = specs.map((spec) => spec.toolSpec.name);
  assert.deepEqual(names, ['check_dispatch_fit', 'update_dispatch_brief']);
  for (const spec of specs) {
    assert.equal(typeof spec.toolSpec.description, 'string');
    assert.equal(spec.toolSpec.inputSchema.json.type, 'object');
  }
});
