/**
 * Completeness layer of the tool-surface eval (layer 4), run by
 * eval-tools.mjs on the real corpora on every deploy.
 *
 * Jamie, 2026-09-30: "It is super important that this MCP not silently
 * exclude or miss things." Every check here compares a tool's answer with
 * an ORACLE computed straight from the raw corpus JSON - never through the
 * tool code - so a tool that drops, double-counts or mis-buckets something
 * fails the deploy. Generic accounting (page + omitted = total_count, count
 * lists sum to total_count) runs on every call in eval-tools'
 * checkInvariants; this file holds the whole-corpus checks.
 *
 * `call(tool, args)` returns the rendered structured result (the MCP
 * client's view); `check(name, ok, detail)` records a pass or failure.
 */

const YEAR_TOOLS = {
  list_content: { topic: 'RSS' },
  find_links: { domain: 'github.com' },
  corpus_stats: {},
  archive_lens: { topic: 'RSS' },
  archive_gems: { mode: 'forgotten' },
  media_search: { query: 'snow' },
  currently_history: {},
  top_references: {},
  on_this_day: { date: '03-15' }
};

// Keys that legitimately differ between two identical calls.
const VOLATILE = new Set(['applied', 'server_version', 'reason', 'results', 'score']);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, entry]) => [key, strip(entry)])
    );
  }
  return value;
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function domainOracle(links, domain) {
  const want = domain.toLowerCase().replace(/^www\./, '');
  return links.filter((link) => {
    const host = hostOf(link.url).replace(/^www\./, '');
    return host === want || host.endsWith(`.${want}`);
  }).length;
}

function yearOf(record) {
  const year = Number(String(record.publish_date || '').slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export async function runCompletenessChecks({ corpora, call, check, counts }) {
  const wt = corpora.weekly_thing || {};
  const blog = corpora.blog || {};
  const podcast = corpora.podcast || {};
  const bySource = {
    weekly_thing: { items: wt.issues || [], links: wt.links || [], media: wt.media || [] },
    blog: { items: blog.posts || [], links: blog.links || [], media: blog.media || [] },
    podcast: { items: podcast.episodes || [], links: podcast.links || [], media: podcast.media || [] }
  };
  const allLinks = [...bySource.weekly_thing.links, ...bySource.blog.links, ...bySource.podcast.links];
  const totalItems = Object.values(bySource).reduce((sum, source) => sum + source.items.length, 0);

  // 1. corpus_stats reports every item and link the corpora hold, and its
  //    per-year counts partition the items.
  {
    const stats = await call('corpus_stats', { limit: 40 });
    for (const source of stats.sources || []) {
      const oracle = bySource[source.source_kind];
      if (!oracle) continue;
      check(
        `completeness corpus_stats ${source.source_kind} item_count`,
        source.item_count === oracle.items.length,
        `${source.item_count} vs ${oracle.items.length}`
      );
      check(
        `completeness corpus_stats ${source.source_kind} link_count`,
        source.link_count === oracle.links.length,
        `${source.link_count} vs ${oracle.links.length}`
      );
      const byYear = (source.counts_by_year || []).reduce((sum, row) => sum + (Number(row.count) || 0), 0);
      check(
        `completeness corpus_stats ${source.source_kind} counts_by_year partitions items`,
        byYear === oracle.items.length,
        `${byYear} vs ${oracle.items.length}`
      );
    }
    check(
      'completeness corpus_stats covers every source kind',
      ['weekly_thing', 'blog', 'podcast'].every((kind) =>
        (stats.sources || []).some((source) => source.source_kind === kind)
      ),
      (stats.sources || []).map((source) => source.source_kind).join(',')
    );
  }

  // 2. on_this_day files every dated source, this year's included (Jamie,
  //    2026-09-30), on exactly one day of this year: the days' totals sum to
  //    those sources, and no listed id repeats. (In a year without Feb 29, 02-29 is Feb 28 and
  //    Feb 29 sources fold into it, so 02-29 is only asked in a leap year.)
  {
    const thisYear = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date())
    );
    const pastItems = Object.values(bySource).reduce(
      (sum, source) => sum + source.items.filter((item) => yearOf(item) <= thisYear).length,
      0
    );
    let sum = 0;
    const seen = new Map();
    for (let month = 1; month <= 12; month += 1) {
      const days = new Date(Date.UTC(thisYear, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        const date = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const result = await call('on_this_day', { date, include_microposts: true, limit_per_year: 20 });
        sum += Number(result.total_count) || 0;
        for (const row of result.years || []) {
          for (const item of row.items || []) seen.set(item.id, (seen.get(item.id) || 0) + 1);
        }
      }
    }
    check('completeness on_this_day days sum to every dated source', sum === pastItems, `${sum} vs ${pastItems}`);
    const repeats = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    check(
      'completeness on_this_day files each source on one day',
      repeats.length === 0,
      repeats.slice(0, 5).join(', ')
    );
    counts.on_this_day_partition = sum;
  }

  // 3. currently_history reaches every Currently entry.
  {
    const result = await call('currently_history', { limit: 120 });
    const oracle = (wt.currently || []).length;
    check('completeness currently_history total', result.total_count === oracle, `${result.total_count} vs ${oracle}`);
  }

  // 4. Domain filters: find_links counts equal a host-equality-or-subdomain
  //    oracle over every link's parsed URL (not its stored domain field).
  for (const domain of ['x.com', 'github.com', 'macstories.net', 'nytimes.com', 'youtube.com', 'micro.blog']) {
    const result = await call('find_links', { domain, limit: 1 });
    const oracle = domainOracle(allLinks, domain);
    check(
      `completeness find_links domain ${domain}`,
      result.total_count === oracle,
      `${result.total_count} vs ${oracle}`
    );
  }

  // 5. `year: Y` is exactly `year_range: [Y, Y]`.
  for (const [tool, args] of Object.entries(YEAR_TOOLS)) {
    const a = await call(tool, { ...args, year: 2021 });
    const b = await call(tool, { ...args, year_range: [2021, 2021] });
    check(
      `completeness ${tool} year equals year_range`,
      JSON.stringify(strip(a)) === JSON.stringify(strip(b)),
      `${JSON.stringify(strip(a)).length} vs ${JSON.stringify(strip(b)).length} chars`
    );
  }

  // 6. Scope partitions: scope all is the sum of each source kind.
  for (const [tool, args] of [
    ['archive_lens', { topic: 'Mastodon' }],
    ['list_content', { topic: 'Mastodon' }],
    ['find_links', { domain: 'github.com' }],
    ['media_search', { query: 'snow' }]
  ]) {
    const all = await call(tool, { ...args, limit: 1 });
    let parts = 0;
    for (const kind of ['weekly_thing', 'blog', 'podcast']) {
      parts += Number((await call(tool, { ...args, source_kind: kind, limit: 1 })).total_count) || 0;
    }
    // media_search in scope all folds a Weekly Thing photo copy into its
    // blog photo and counts the fold (Jamie, 2026-09-30: the blog is
    // canonical); the identity holds with the folded copies added back.
    const folded = Number(all.collapsed_copies) || 0;
    check(
      `completeness ${tool} scope all + collapsed copies = sum of kinds`,
      all.total_count + folded === parts,
      `${all.total_count} + ${folded} vs ${parts}`
    );
  }

  // 7. Year partitions: the per-year totals sum to the unfiltered total.
  for (const [tool, args] of [
    ['archive_lens', { topic: 'Mastodon' }],
    ['find_links', { domain: 'github.com' }]
  ]) {
    const all = await call(tool, { ...args, limit: 1 });
    let parts = 0;
    for (let year = 2000; year <= new Date().getUTCFullYear(); year += 1) {
      parts += Number((await call(tool, { ...args, year, limit: 1 })).total_count) || 0;
    }
    check(`completeness ${tool} years sum to total`, all.total_count === parts, `${all.total_count} vs ${parts}`);
  }

  // 8. Reachability: every source resolves through get_source, by the id
  //    tools emit and by its url (a url several posts share must say so and
  //    name each of them, never open one).
  {
    const missing = [];
    for (const issue of bySource.weekly_thing.items) {
      const result = await call('get_source', { id: `WT${issue.number}`, format: 'outline' });
      if (result.source?.issue_number !== issue.number) missing.push(`WT${issue.number}`);
    }
    const posts = bySource.blog.items;
    const urlCounts = new Map();
    for (const post of posts) urlCounts.set(post.url, (urlCounts.get(post.url) || 0) + 1);
    const ambiguous = [];
    for (const post of posts) {
      const byId = await call('get_source', { id: `blog-${post.microblog_id}`, format: 'outline' });
      if (byId.source?.subject !== post.subject) missing.push(`blog-${post.microblog_id}`);
      const byUrl = await call('get_source', { id: post.url, format: 'outline' });
      if (urlCounts.get(post.url) > 1) {
        const named = new Set((byUrl.candidates || []).map((candidate) => candidate.id));
        const expected = posts.filter((item) => item.url === post.url).map((item) => `blog-${item.microblog_id}`);
        if (byUrl.code !== 'bad_request' || named.size !== expected.length || !expected.every((id) => named.has(id))) {
          ambiguous.push(post.url);
        }
      } else if (byUrl.source?.subject !== post.subject) missing.push(post.url);
    }
    check(
      'completeness a shared url names every post it could mean',
      ambiguous.length === 0,
      ambiguous.slice(0, 3).join(', ')
    );
    for (const form of ['WT140-special', '140-special', 'wt-140-special']) {
      const result = await call('get_source', { id: form, format: 'outline' });
      if (result.source?.id !== 'wt-140-special') missing.push(form);
    }
    for (const episode of bySource.podcast.items) {
      const result = await call('get_source', { id: `ep-${episode.number}`, format: 'outline' });
      if (result.source?.subject !== episode.subject) missing.push(`ep-${episode.number}`);
    }
    // The Weekly Thing's own pages: one source per url, every chunk in it.
    const pages = new Map();
    for (const chunk of wt.chunks || []) {
      if (chunk.issue_number != null && chunk.issue_number !== '') continue;
      pages.set(chunk.url, (pages.get(chunk.url) || 0) + 1);
    }
    for (const [url, chunkCount] of pages) {
      const id = `site-${url.replace(/\/+$/, '').split('/').at(-1)}`;
      const byId = await call('get_source', { id, format: 'outline' });
      const byUrl = await call('get_source', { id: url, format: 'outline' });
      if (byId.source?.id !== id || byUrl.source?.id !== id) missing.push(id);
      else if (!byId.source.sections?.length || byId.source.word_count <= 0)
        missing.push(`${id} (empty of ${chunkCount} chunks)`);
    }
    counts.site_pages = pages.size;
    check(
      'completeness every source resolves through get_source',
      missing.length === 0,
      missing.slice(0, 5).join(', ')
    );

    // Posts that share a permalink (micro.blog gave several imports the same
    // 000000.html) are still distinct sources: each reads as its own words,
    // measured against its own chunks (chunk ids carry the microblog id).
    const ownWords = new Map();
    for (const chunk of blog.chunks || []) {
      const id = String(chunk.id || '').split(':')[1];
      ownWords.set(id, (ownWords.get(id) || 0) + (Number(chunk.word_count) || 0));
    }
    const merged = [];
    for (const post of posts.filter((item) => urlCounts.get(item.url) > 1)) {
      const result = await call('get_source', { id: `blog-${post.microblog_id}`, format: 'outline' });
      const words = Number(result.source?.word_count) || 0;
      const own = ownWords.get(String(post.microblog_id)) || 0;
      if (result.source?.subject !== post.subject || words > own * 1.2 + 20) {
        merged.push(`blog-${post.microblog_id} (${words} words vs ${own})`);
      }
    }
    check('completeness posts sharing a permalink stay distinct', merged.length === 0, merged.slice(0, 4).join(', '));
    counts.shared_permalink_posts = posts.filter((item) => urlCounts.get(item.url) > 1).length;
  }

  // 8b. Every id a tool emits is one get_source resolves: an id the caller
  //     cannot open is a dead end.
  {
    const emitted = new Set();
    const collect = (value) => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          if ((key === 'id' || key === 'source_id') && typeof entry === 'string' && /^(wt|blog|ep|site)-/.test(entry)) {
            emitted.add(entry);
          } else collect(entry);
        }
      }
    };
    for (const topic of ['Mastodon', 'RSS', 'micro.blog', 'Apple Watch', 'running']) {
      collect(await call('archive_lens', { topic, limit: 40 }));
      collect(await call('list_content', { topic, limit: 120 }));
    }
    collect(await call('find_links', { domain: 'micro.blog', limit: 50 }));
    collect(await call('latest_content', { limit: 30 }));
    collect(await call('archive_gems', { limit: 12 }));
    collect(await call('on_this_day', { date: '10-11', limit_per_year: 20 }));
    collect(await call('media_search', { query: 'snow', limit: 12 }));
    collect(await call('search_faq', { query: 'membership' }));
    const dead = [];
    for (const id of emitted) {
      const result = await call('get_source', { id, format: 'outline' });
      if (result.source?.id !== id) dead.push(id);
    }
    check(
      'completeness every emitted id resolves',
      dead.length === 0,
      `${dead.length} of ${emitted.size}: ${dead.slice(0, 4).join(', ')}`
    );
  }

  // 8c. Every word is readable. A Weekly Thing body read page by page with
  //     get_source's offset is the whole issue (QA F5); every ## and ###
  //     heading in a body, asked for as a section, returns text (QA F6);
  //     and a neighbourhood's outgoing_count and find_links id both count
  //     every link the issue carries (QA F7).
  {
    const short = [];
    for (const issue of bySource.weekly_thing.items) {
      let offset = 0;
      let text = '';
      for (let page = 0; page < 10; page += 1) {
        const result = await call('get_source', {
          id: `wt-${issue.number}`,
          format: 'text',
          ...(offset ? { offset } : {})
        });
        text += String(result.source?.body || '');
        offset = result.truncated?.next_offset || 0;
        if (!offset) break;
      }
      if (text !== String(issue.body || ''))
        short.push(`wt-${issue.number} ${text.length}/${String(issue.body || '').length}`);
    }
    check('completeness every issue body reads whole with offset', short.length === 0, short.slice(0, 4).join(', '));

    const empty = [];
    let headings = 0;
    for (const issue of bySource.weekly_thing.items) {
      for (const line of String(issue.body || '').split('\n')) {
        const heading = /^#{2,3}\s+(.*?)\s*$/.exec(line);
        if (!heading) continue;
        headings += 1;
        const result = await call('get_source', { id: `wt-${issue.number}`, section: heading[1], format: 'text' });
        if (result.error || !String(result.source?.body || '').trim()) empty.push(`wt-${issue.number} "${heading[1]}"`);
      }
    }
    check(
      'completeness every body heading reads as a section',
      headings > 0 && empty.length === 0,
      `${empty.length} of ${headings}: ${empty.slice(0, 4).join(', ')}`
    );

    const perIssue = new Map();
    for (const link of bySource.weekly_thing.links) {
      perIssue.set(String(link.issue_number), (perIssue.get(String(link.issue_number)) || 0) + 1);
    }
    const busiest = [...perIssue].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const miscounted = [];
    for (const [issue, count] of busiest) {
      const near = await call('source_neighborhood', { id: `wt-${issue}` });
      const listed = await call('find_links', { id: `wt-${issue}`, limit: 1 });
      if (near.outgoing_count !== count || listed.total_count !== count) {
        miscounted.push(`wt-${issue} ${near.outgoing_count}/${listed.total_count} vs ${count}`);
      }
    }
    check(
      'completeness neighbourhood and find_links id count every link',
      miscounted.length === 0,
      miscounted.join(', ')
    );
  }

  // 8d. Audio editions (2.3.0): has_audio and corpus_stats audio_editions
  //     count every issue whose corpus record carries an audio url, the
  //     true and false lists partition the issues, and every chapter start
  //     a section read returns is one of that issue's chapters.
  {
    const withAudio = bySource.weekly_thing.items.filter((issue) => issue.audio?.url);
    const seconds = Math.round(withAudio.reduce((sum, issue) => sum + (Number(issue.audio.duration_seconds) || 0), 0));
    const yes = await call('list_content', { has_audio: true, limit: 1 });
    const no = await call('list_content', { has_audio: false, limit: 1 });
    const latest = await call('latest_content', { has_audio: true, limit: 1 });
    check(
      'completeness has_audio true counts every audio edition',
      yes.total_count === withAudio.length && latest.total_count === withAudio.length,
      `${yes.total_count}/${latest.total_count} vs ${withAudio.length}`
    );
    check(
      'completeness has_audio true and false partition the issues',
      yes.total_count + no.total_count === bySource.weekly_thing.items.length,
      `${yes.total_count} + ${no.total_count} vs ${bySource.weekly_thing.items.length}`
    );
    const stats = await call('corpus_stats', { source_kind: 'weekly_thing', limit: 1 });
    const editions = stats.sources?.[0]?.audio_editions || {};
    check(
      'completeness corpus_stats audio_editions count and length',
      editions.count === withAudio.length && editions.total_seconds === seconds,
      `${editions.count}/${editions.total_seconds} vs ${withAudio.length}/${seconds}`
    );
    const wrongStart = [];
    for (const issue of withAudio.slice(-12)) {
      const out = await call('get_source', { id: `wt-${issue.number}`, section: 'Journal', format: 'outline' });
      const audio = out.source?.section_audio;
      if (!audio) continue;
      const starts = (issue.audio.chapters || []).map((chapter) => Math.floor(Number(chapter.start)));
      if (!starts.includes(audio.start) || !String(audio.url).startsWith(issue.audio.url)) {
        wrongStart.push(`wt-${issue.number} ${audio.start}`);
      }
    }
    check('completeness section_audio starts a real chapter', wrongStart.length === 0, wrongStart.join(', '));
    counts.audio_editions = withAudio.length;
  }

  // 8e. A blog photo's also_in_issues names every issue it ran in, whatever
  //     the query matched, and only on the post its copies name (QA M2-1,
  //     M2-5: "family" lacked it on 137 of 246; 3 urls credited the wrong post).
  {
    const ranIn = new Map();
    for (const item of bySource.weekly_thing.media) {
      if (item.copy_of_microblog_id == null || !item.canonical_url) continue;
      const key = `blog-${item.copy_of_microblog_id}\0${String(item.canonical_url).replace(/^https?:/, '')}`;
      if (!ranIn.has(key)) ranIn.set(key, new Set());
      ranIn.get(key).add(String(item.issue_number));
    }
    for (const args of [{ query: 'family' }, { query: 'family', source_kind: 'blog' }, { year: 2026 }]) {
      const wrong = [];
      for (let offset = 0; offset !== undefined;) {
        const page = await call('media_search', { ...args, limit: 12, offset });
        for (const item of page.results || []) {
          if (item.source_kind !== 'blog') continue;
          const want = [...(ranIn.get(`${item.source_id}\0${String(item.image_url).replace(/^https?:/, '')}`) || [])]
            .sort()
            .join(',');
          const got = (item.also_in_issues || []).map(String).sort().join(',');
          if (want !== got) wrong.push(`${item.source_id} ${got || '-'} vs ${want || '-'}`);
        }
        offset = page.truncated?.next_offset;
      }
      check(
        `completeness media_search also_in_issues names every issue (${JSON.stringify(args)})`,
        wrong.length === 0,
        `${wrong.length}: ${wrong.slice(0, 4).join('; ')}`
      );
    }
  }

  // 9. Corpus size into the baseline: a build that drops more than 10% of
  //    the sources or links fails the band even when every tool is honest.
  counts.corpus_items = totalItems;
  counts.corpus_links = allLinks.length;
  const undated = Object.values(bySource).flatMap((source) => source.items.filter((item) => !yearOf(item)));
  check(
    'completeness every source is dated',
    undated.length === 0,
    undated
      .slice(0, 5)
      .map((item) => item.url)
      .join(', ')
  );
}
