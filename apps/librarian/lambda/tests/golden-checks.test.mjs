import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyJournalPassages } from '../scripts/golden-checks.mjs';
test('Journal acceptance follows the canonical family and supports legacy literal headings', () => {
  assert.equal(
    onlyJournalPassages([
      { source_kind: 'weekly_thing', section: 'Stream', section_family: 'Journal' },
      { source_kind: 'weekly_thing', section: 'Journal' }
    ]),
    true
  );
});
test('a title containing Journal cannot bypass the exact family or source boundary', () => {
  for (const row of [
    { source_kind: 'weekly_thing', section: 'Journal thoughts', section_family: 'Notable' },
    { source_kind: 'weekly_thing', section: 'Journal metadata' },
    { source_kind: 'blog', section_family: 'Journal' }
  ])
    assert.equal(onlyJournalPassages([row]), false);
  assert.equal(onlyJournalPassages([]), false);
});
