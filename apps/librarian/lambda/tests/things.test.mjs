import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
import { isSitePage, isThing, lensSourceId } from '../dist/shared/archive-lens.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

// Things I've built (thingelstad.xyz) rides the Weekly Thing corpus as
// undated `thing` chunks: one source per thing plus the registry index.
const THING_URL = 'https://thingelstad.xyz/things/weekly-thing/';
const thingChunk = (id, text, extra = {}) => ({
  id,
  issue_number: null,
  subject: 'Weekly Thing',
  publish_date: null,
  issue_year: null,
  url: THING_URL,
  section: 'Thing',
  text,
  word_count: text.split(/\s+/).length,
  content_kind: 'thing',
  topics: [],
  source_kind: 'thing',
  thing_id: 'weekly-thing',
  thing_status: 'active',
  started: '2017-05-13',
  ended: null,
  ...extra
});

function fixtures() {
  return {
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Tidepools and the fall',
          publish_date: '2024-09-29T12:00:00Z',
          url: '/archive/300/',
          sections: [{ name: 'Issue', text: 'Tidepools at low tide.' }],
          body: 'Tidepools at low tide.'
        }
      ],
      chunks: [
        thingChunk(
          'thing:weekly-thing:0',
          'Weekly Thing: A weekly collection of links and ideas. Status: active (being built or operated).'
        ),
        thingChunk('thing:weekly-thing:1', 'History: - 2017-05-13: The first Weekly Thing.'),
        thingChunk('thing:index:0', "Things I've built is Jamie Thingelstad's registry of his projects: 2 things.", {
          subject: "Things I've built",
          section: 'Things',
          url: 'https://thingelstad.xyz/',
          thing_id: undefined,
          thing_status: undefined,
          started: undefined
        })
      ],
      links: [],
      media: []
    },
    blog: { posts: [], chunks: [], links: [] },
    podcast: { episodes: [], chunks: [], links: [] }
  };
}

test('a thing has one id everywhere: thing-<id>, and thing-index for the registry', () => {
  const chunk = fixtures().weekly_thing.chunks[0];
  assert.equal(lensSourceId(chunk), 'thing-weekly-thing');
  assert.equal(lensSourceId(fixtures().weekly_thing.chunks[2]), 'thing-index');
  assert.equal(isThing(chunk), true);
  assert.equal(isSitePage(chunk), false);
  assert.equal(isThing({ source_kind: 'site_page', url: '/about/' }), false);
});

test('get_source opens a thing whole, every chunk at its page, and the index too', async () => {
  primeCorpusCachesForTests(fixtures());
  const thing = await ARCHIVE_TOOLS.get_source({ id: 'thing-weekly-thing' }, { scope: 'all' });
  assert.equal(thing.source.id, 'thing-weekly-thing');
  assert.equal(thing.source.url, THING_URL);
  assert.equal(thing.source.source_kind, 'thing');
  const body = JSON.stringify(thing);
  assert.match(body, /being built or operated/);
  assert.match(body, /The first Weekly Thing/);
  assert.doesNotMatch(body, /registry of his projects/);

  const byUrl = await ARCHIVE_TOOLS.get_source({ id: THING_URL, format: 'outline' }, { scope: 'all' });
  assert.equal(byUrl.source?.id, 'thing-weekly-thing', JSON.stringify(byUrl).slice(0, 300));
  assert.ok(
    byUrl.source.sections?.length > 0 && byUrl.source.word_count > 0,
    JSON.stringify(byUrl.source).slice(0, 300)
  );

  const index = await ARCHIVE_TOOLS.get_source({ id: 'thing-index' }, { scope: 'all' });
  assert.equal(index.source.id, 'thing-index');
  assert.equal(index.source.url, 'https://thingelstad.xyz/');
  assert.match(JSON.stringify(index), /registry of his projects/);
});
