// MCP 2.1.0 links (QA 2026-09-30, findings L5-L14): a malformed stored host
// never ranks, every excluded link is counted in the window it was asked
// for, utility sites are matched with their subdomains, target_resolved
// speaks only of Jamie's own sites, tracking parameters never split a url,
// and both link tools page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, linkDomain, linkUrlKey } from '../dist/shared/archive-tools.mjs';
import canonicalUrls from './fixtures/canonical-urls.json' with { type: 'json' };
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

const D23 = '2023-05-06T12:00:00Z';
const D24 = '2024-05-04T12:00:00Z';

function wtLink(issue, date, domain, extra = {}) {
  return {
    issue_number: issue,
    issue_year: Number(date.slice(0, 4)),
    publish_date: date,
    subject: `WT${issue}`,
    domain,
    url: `https://${domain}/${issue}`,
    text: `A ${domain} piece`,
    link_role: 'headline',
    ...extra
  };
}

function blogLink(id, date, url, extra = {}) {
  return {
    source_kind: 'blog',
    microblog_id: id,
    post_year: Number(date.slice(0, 4)),
    publish_date: date,
    subject: `Post ${id}`,
    url,
    domain: new URL(url).hostname,
    link_kind: 'external',
    link_category: 'external',
    target_resolved: false,
    ...extra
  };
}

function fixtures() {
  return {
    weekly_thing: {
      issues: [
        { number: 1, subject: 'WT1', publish_date: D23, url: '/archive/1/', body: 'One.' },
        { number: 2, subject: 'WT2', publish_date: D24, url: '/archive/2/', body: 'Two.' }
      ],
      chunks: [],
      links: [
        wtLink(1, D23, 'daringfireball.net'),
        wtLink(1, D23, 'en.wikipedia.org'),
        wtLink(2, D24, 'en.m.wikipedia.org'),
        wtLink(2, D24, 'mobile.twitter.com'),
        wtLink(2, D24, 'daringfireball.net'),
        wtLink(2, D24, 'stratechery.com'),
        wtLink(2, D24, 'dakotacooks.com'),
        wtLink(2, D24, 'vox.com', { link_role: 'commentary' }),
        wtLink(2, D24, 'www.thingelstad.com', {
          url: 'https://www.thingelstad.com/2024/05/01/post.html',
          target_resolved: true
        }),
        wtLink(2, D24, 'www.thingelstad.com', {
          url: 'https://www.thingelstad.com/2024/05/02/gone.html',
          target_resolved: false
        }),
        wtLink(2, D24, 'www.nytimes.com', { url: 'https://www.nytimes.com/2024/05/01/tech/a.html?smid=url-share' })
      ]
    },
    blog: {
      posts: [],
      chunks: [],
      links: [
        // The double-scheme typo: stored as an external link to "https".
        blogLink(7, D24, 'https://https://www.thingelstad.com/candles/', { domain: 'https' }),
        blogLink(8, D24, 'https://www.thingelstad.com/candles/', {
          link_kind: 'internal',
          link_category: 'internal_site'
        }),
        blogLink(9, D24, 'http://carcassonne:///f/board', { domain: 'carcassonne' }),
        blogLink(10, D24, 'https://www.hwardmiles.com./about', { domain: 'www.hwardmiles.com.' }),
        blogLink(11, D24, 'https://cleantechnica.com/2020/a/?fbclid=IwAR0')
      ]
    }
  };
}

test('linkDomain: a stored non-host gives way to the url, and a dotless host names nothing', () => {
  assert.equal(linkDomain({ domain: 'https', url: 'https://https://www.thingelstad.com/candles/' }), 'thingelstad.com');
  assert.equal(linkDomain({ domain: 'carcassonne', url: 'http://carcassonne:///f/board' }), '');
  assert.equal(linkDomain({ domain: 'www.hwardmiles.com.' }), 'hwardmiles.com');
  assert.equal(linkDomain({ domain: 'WWW.MacStories.net' }), 'macstories.net');
});

test('linkUrlKey: tracking parameters and a doubled scheme never split a url', () => {
  const clean = linkUrlKey('https://cleantechnica.com/2020/a/');
  for (const tracked of [
    'https://cleantechnica.com/2020/a/?fbclid=IwAR0',
    'https://cleantechnica.com/2020/a/?utm_source=x&smid=y',
    'http://www.cleantechnica.com/2020/a?ref_src=twsrc&si=abc#top'
  ]) {
    assert.equal(linkUrlKey(tracked), clean, tracked);
  }
  assert.equal(linkUrlKey('https://https://www.thingelstad.com/candles/'), linkUrlKey('thingelstad.com/candles'));
  assert.equal(linkUrlKey('https://twitter.com/yelp/status/1?s=20'), linkUrlKey('https://twitter.com/yelp/status/1'));
  assert.notEqual(
    linkUrlKey('https://example.com/search?s=20'),
    linkUrlKey('https://example.com/search'),
    's is a tracker only on twitter.com and x.com'
  );
  assert.notEqual(linkUrlKey('https://example.com/?p=1'), linkUrlKey('https://example.com/?p=2'));
});

test('linkUrlKey: a percent-encoded path keys the same as its plain spelling (QA2 L2-1)', () => {
  const pairs = [
    ['https://en.wikipedia.org/wiki/Elf_(film)', 'https://en.wikipedia.org/wiki/Elf_%28film%29'],
    ["https://en.wikipedia.org/wiki/Dunbar's_number", 'https://en.wikipedia.org/wiki/Dunbar%27s_number'],
    ['https://en.wikipedia.org/wiki/Mölkky', 'https://en.wikipedia.org/wiki/M%c3%b6lkky'],
    ['https://en.wikipedia.org/wiki/M%C3%B6lkky', 'https://en.wikipedia.org/wiki/M%c3%b6lkky']
  ];
  for (const [plain, encoded] of pairs) assert.equal(linkUrlKey(encoded), linkUrlKey(plain), encoded);
  assert.notEqual(linkUrlKey('https://example.com/a%2Fb'), linkUrlKey('https://example.com/a/b'), 'an encoded slash');
  assert.equal(linkUrlKey('https://example.com/100%'), 'example.com/100%', 'a bad escape stays');
});

test('top_references: every excluded link is counted in the window asked for', async () => {
  primeCorpusCachesForTests(fixtures());
  const y2024 = await ARCHIVE_TOOLS.top_references({ year: 2024, source_kind: 'weekly_thing' }, { scope: 'all' });
  assert.equal(y2024.excluded_utility_links, 2, 'en.m.wikipedia.org and mobile.twitter.com, 2024 only');
  assert.equal(y2024.excluded_internal_links, 2);
  assert.equal(y2024.excluded_non_headline_links, 1, 'the vox.com commentary link');
  assert.deepEqual(
    y2024.top.map((row) => row.domain),
    ['dakotacooks.com', 'daringfireball.net', 'nytimes.com', 'stratechery.com'],
    'ties by domain, never corpus order'
  );
  assert.equal(y2024.counted_links, 4);
  assert.ok(y2024.utility_domains.includes('wikipedia.org'));

  const none = await ARCHIVE_TOOLS.top_references({ year: 1999 }, { scope: 'all' });
  assert.equal(none.excluded_utility_links, 0, 'no links in 1999, so none were left out');
  assert.equal(none.total_count, 0);

  const withUtility = await ARCHIVE_TOOLS.top_references(
    { year: 2024, source_kind: 'weekly_thing', include_utility: true },
    { scope: 'all' }
  );
  assert.ok(withUtility.top.some((row) => row.domain === 'en.m.wikipedia.org'));
  assert.equal(withUtility.utility_domains, undefined);
});

test('top_references: a malformed host never ranks, and the typo counts as internal', async () => {
  primeCorpusCachesForTests(fixtures());
  const blog = await ARCHIVE_TOOLS.top_references({ source_kind: 'blog' }, { scope: 'all' });
  const domains = blog.top.map((row) => row.domain);
  assert.ok(!domains.includes('https'));
  assert.ok(!domains.includes('carcassonne'));
  assert.ok(domains.every((domain) => domain.includes('.') && !domain.endsWith('.')));
  assert.ok(domains.includes('hwardmiles.com'));
  assert.equal(blog.excluded_internal_links, 2, 'the candles typo and the candles link');
  assert.equal(blog.excluded_malformed_links, 1);
});

test('top_references pages with offset', async () => {
  primeCorpusCachesForTests(fixtures());
  const first = await ARCHIVE_TOOLS.top_references({ source_kind: 'weekly_thing', limit: 2 }, { scope: 'all' });
  assert.deepEqual(
    first.top.map((row) => row.domain),
    ['daringfireball.net', 'dakotacooks.com']
  );
  assert.equal(first.truncated.next_offset, 2);
  assert.equal(first.truncated.omitted.top, first.total_count - 2);
  const second = await ARCHIVE_TOOLS.top_references(
    { source_kind: 'weekly_thing', limit: 2, offset: 2 },
    { scope: 'all' }
  );
  assert.deepEqual(
    second.top.map((row) => row.domain),
    ['nytimes.com', 'stratechery.com']
  );
});

test('find_links: target_resolved speaks only of links to Jamie own sites', async () => {
  primeCorpusCachesForTests(fixtures());
  const unresolved = await ARCHIVE_TOOLS.find_links({ target_resolved: false }, { scope: 'all' });
  const internalUnresolved = await ARCHIVE_TOOLS.find_links(
    { target_resolved: false, link_kind: 'internal' },
    { scope: 'all' }
  );
  assert.equal(unresolved.total_count, internalUnresolved.total_count);
  assert.ok(unresolved.results.every((row) => row.link_kind === 'internal'));
  assert.equal(unresolved.total_count, 3, 'WT2 gone.html, and both candles links');
  const resolved = await ARCHIVE_TOOLS.find_links({ target_resolved: true }, { scope: 'all' });
  assert.equal(resolved.total_count, 1);
});

test('find_links: the typo is found on its real host and url; tracked urls match clean ones', async () => {
  primeCorpusCachesForTests(fixtures());
  const candles = await ARCHIVE_TOOLS.find_links({ url: 'https://www.thingelstad.com/candles/' }, { scope: 'all' });
  assert.equal(candles.total_count, 2);
  assert.ok(candles.results.every((row) => row.domain === 'thingelstad.com'));
  const junk = await ARCHIVE_TOOLS.find_links({ domain: 'https' }, { scope: 'all' });
  assert.equal(junk.code, 'bad_request', 'a scheme is not a host');
  const own = await ARCHIVE_TOOLS.find_links({ domain: 'thingelstad.com', source_kind: 'blog' }, { scope: 'all' });
  assert.equal(own.total_count, 2);
  const tracked = await ARCHIVE_TOOLS.find_links({ url: 'https://cleantechnica.com/2020/a/' }, { scope: 'all' });
  assert.equal(tracked.total_count, 1);
  const nyt = await ARCHIVE_TOOLS.find_links(
    { url: 'https://www.nytimes.com/2024/05/01/tech/a.html' },
    { scope: 'all' }
  );
  assert.equal(nyt.total_count, 1);
  const kinds = await ARCHIVE_TOOLS.find_links({ source_kind: 'blog' }, { scope: 'all' });
  assert.deepEqual(kinds.counts_by_link_kind, [
    { link_kind: 'external', count: 3 },
    { link_kind: 'internal', count: 2 }
  ]);
});

test('find_links: top_domains says how many domains it left out', async () => {
  const many = fixtures();
  many.weekly_thing.links = Array.from({ length: 25 }, (_, index) => wtLink(2, D24, `site${index}.example`));
  primeCorpusCachesForTests(many);
  const out = await ARCHIVE_TOOLS.find_links({ limit: 50 }, { scope: 'weekly_thing' });
  assert.equal(out.top_domains.length, 20);
  assert.equal(out.truncated.omitted.top_domains, 5);
  assert.match(out.truncated.hint, /top_domains is the 20 most linked of 25/);
});

// Plan 2026-10-01 section 3: WT Builder's "linked before" check and this
// index key a link one way. The fixture is WT Builder's contract, copied.
test('linkUrlKey agrees with WT Builder on every canonical-urls case', () => {
  for (const { url, key } of canonicalUrls.cases) assert.equal(linkUrlKey(url), key, url);
  for (const [a, b] of canonicalUrls.different) assert.notEqual(linkUrlKey(a), linkUrlKey(b), `${a} vs ${b}`);
  assert.equal(linkUrlKey('https://amp.dev/documentation'), 'amp.dev/documentation', 'amp.dev is its own site');
  assert.equal(linkUrlKey('https://m.me/someone'), 'm.me/someone', 'm.me is its own site');
});
