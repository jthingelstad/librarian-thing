import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { collectToolCitations } from '../dist/shared/archive-tools.mjs';
import { prioritizeCitationsForAnswer } from '../dist/shared/citations.mjs';

// Regression net for the 2026-09-02 outage: a whole-issue source record
// carried section: null, the citations SSE event streamed it verbatim, and
// the web client - which validates every stream event against the contract
// (section typed string) - dropped citations + done as a malformed stream
// on every tool-using answer. Any field the contract types as a plain
// string must be emitted as a string or omitted, never null.

const contract = JSON.parse(readFileSync(new URL('../../contracts/librarian-api.json', import.meta.url), 'utf8'));
const citationDef = contract.$defs.citation;
const stringFields = Object.entries(citationDef.properties)
  .filter(([, schema]) => schema.type === 'string')
  .map(([name]) => name);

function assertContractSafe(citation, label) {
  for (const field of stringFields) {
    const value = citation[field];
    assert.ok(
      value === undefined || typeof value === 'string',
      `${label}: ${field} must be a string or omitted, got ${JSON.stringify(value)}`
    );
  }
}

test('collectToolCitations never emits null for contract string fields', () => {
  const citations = collectToolCitations([
    {
      results: [
        // The exact record shape that caused the outage: whole-issue source
        // with explicit nulls.
        {
          issue_number: 318,
          source_kind: 'weekly_thing',
          subject: null,
          publish_date: null,
          section: null,
          url: null,
          also_in_issues: null
        },
        // External source with nulls in optional media fields.
        {
          issue_number: null,
          source_kind: 'blog',
          subject: 'A post',
          publish_date: '2025-05-06',
          section: null,
          url: 'https://example.com/post',
          transcript_url: null,
          audio_url: null,
          show: null
        }
      ]
    }
  ]);
  assert.ok(citations.length >= 2);
  citations.forEach((citation, index) => assertContractSafe(citation, `citation[${index}]`));
  assert.ok(stringFields.includes('section'), 'contract still types section as string');
});

test('catalog backfill citations are contract-safe with a null publish_date', () => {
  const catalog = new Map([['123', { number: 123, subject: 'WT 123', publish_date: null, url: '/archive/123/' }]]);
  const citations = prioritizeCitationsForAnswer([], 'As covered in WT123.', catalog, new Set([123]));
  assert.equal(citations.length, 1);
  assertContractSafe(citations[0], 'backfill');
});
