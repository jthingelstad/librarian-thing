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

// A blog source's id: page-<uid> for a micro.blog page (a number space of
// its own; 2.4.0), blog-<microblog id> for a post.
function blogId(record) {
  return record.page_id != null && record.page_id !== '' ? `page-${record.page_id}` : `blog-${record.microblog_id}`;
}

function yearOf(record) {
  const year = Number(String(record.publish_date || '').slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export async function runCompletenessChecks({ corpora, call, check, checkCorpus = check, counts, retrieval = {} }) {
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
  // Pages are undated (2.4.0): every listing holds them, no date tool does.
  const undatedItems = Object.values(bySource).flatMap((source) => source.items.filter((item) => !yearOf(item)));
  // The Chicago day each source was published on, by id (Jamie, 2026-09-30:
  // "All of my content should be shown in Chicago time").
  const chicago = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // The oracle day: a timestamp's Chicago date; a bare date is already local.
  const dayOf = (record) => {
    const stamp = String(record.published || record.publish_date || '').trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(stamp) ? chicago.format(Date.parse(stamp)) : stamp.slice(0, 10);
  };
  const oracleDay = new Map([
    ...bySource.weekly_thing.items.map((issue) => [`wt-${issue.number}`, dayOf(issue)]),
    ...bySource.blog.items.map((post) => [blogId(post), dayOf(post)]),
    ...bySource.podcast.items.map((episode) => [`ep-${episode.number}`, dayOf(episode)])
  ]);

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
      const pages = Number(source.page_count) || 0;
      check(
        `completeness corpus_stats ${source.source_kind} counts_by_year + page_count partitions items`,
        byYear + pages === oracle.items.length,
        `${byYear} + ${pages} vs ${oracle.items.length}`
      );
      const oraclePages = oracle.items.filter((item) => item.page_id != null).length;
      check(
        `completeness corpus_stats ${source.source_kind} page_count`,
        pages === oraclePages,
        `${pages} vs ${oraclePages}`
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

  // 1b. Within a year, corpus_stats' oldest and newest are the first and
  //     last days the year filter keeps (QA2 T2-3: 2020's oldest blog post
  //     was an April Blot import published in 2018).
  {
    const wrong = [];
    const undated = [];
    for (const kind of ['weekly_thing', 'blog', 'podcast']) {
      const yearField = kind === 'blog' ? 'post_year' : 'issue_year';
      const byYear = new Map();
      for (const item of bySource[kind].items) {
        const year = Number(item[yearField]) || yearOf(item);
        const day = String(item.publish_date || '').slice(0, 10);
        if (!year || !day) continue;
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(day);
      }
      for (const [year, days] of byYear) {
        days.sort();
        const stats = await call('corpus_stats', { source_kind: kind, year, limit: 1 });
        const source = stats.sources?.[0] || {};
        const oldest = String(source.oldest?.publish_date || '').slice(0, 10);
        const newest = String(source.newest?.publish_date || '').slice(0, 10);
        if (oldest !== days[0] || newest !== days.at(-1)) {
          wrong.push(`${kind} ${year}: ${oldest}..${newest} vs ${days[0]}..${days.at(-1)}`);
        }
        for (const end of [source.oldest, source.newest]) {
          if (!end?.date || end.date !== oracleDay.get(end.id))
            undated.push(`${end?.id} ${end?.date} (oracle ${oracleDay.get(end?.id)})`);
        }
      }
    }
    check(
      'completeness corpus_stats oldest and newest bound each year',
      wrong.length === 0,
      wrong.slice(0, 4).join('; ')
    );
    check(
      'completeness corpus_stats oldest and newest carry their Chicago date',
      undated.length === 0,
      `${undated.length}: ${undated.slice(0, 4).join('; ')}`
    );
  }

  // 2. on_this_day files every dated source, this year's included (Jamie,
  //    2026-09-30), on exactly one day of the target year: the days' totals
  //    sum to those sources, no listed id repeats, and every item sits on
  //    its own Chicago day (QA2 T2-7: a revert to UTC days, or a lost Feb 29
  //    rule, still summed right). Run for this year and for 2028, a leap
  //    year where Feb 29 is its own day. (In a year without Feb 29, 02-29 is
  //    Feb 28 and Feb 29 sources fold into it, so 02-29 is only asked in a
  //    leap year.)
  {
    const thisYear = Number(chicago.format(new Date()).slice(0, 4));
    for (const target of [...new Set([thisYear, 2028])]) {
      const leap = new Date(Date.UTC(target, 1, 29)).getUTCMonth() === 1;
      const pastItems = [...oracleDay.values()].filter((day) => day && Number(day.slice(0, 4)) <= target).length;
      let sum = 0;
      const seen = new Map();
      const misdated = [];
      for (let month = 1; month <= 12; month += 1) {
        const days = new Date(Date.UTC(target, month, 0)).getUTCDate();
        for (let day = 1; day <= days; day += 1) {
          const monthDay = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const result = await call('on_this_day', {
            date: `${target}-${monthDay}`,
            include_microposts: true,
            limit_per_year: 20
          });
          sum += Number(result.total_count) || 0;
          for (const row of result.years || []) {
            for (const item of row.items || []) {
              seen.set(item.id, (seen.get(item.id) || 0) + 1);
              const onDay =
                item.date.slice(5) === monthDay || (!leap && monthDay === '02-28' && item.date.slice(5) === '02-29');
              if (item.date !== oracleDay.get(item.id) || !onDay || Number(item.date.slice(0, 4)) !== row.year) {
                misdated.push(`${item.id} ${item.date} on ${monthDay} (oracle ${oracleDay.get(item.id)})`);
              }
            }
          }
        }
      }
      check(
        `completeness on_this_day ${target} days sum to every dated source`,
        sum === pastItems,
        `${sum} vs ${pastItems}`
      );
      const repeats = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
      check(
        `completeness on_this_day ${target} files each source on one day`,
        repeats.length === 0,
        repeats.slice(0, 5).join(', ')
      );
      check(
        `completeness on_this_day ${target} files each item on its Chicago day`,
        seen.size > 0 && misdated.length === 0,
        `${misdated.length}: ${misdated.slice(0, 4).join('; ')}`
      );
      if (target === thisYear) counts.on_this_day_partition = sum;
    }
  }

  // 2b. A capped on_this_day page (QA2 T2-1): following next_offset to the
  //     end shows every item exactly once. The cap once dropped whole years
  //     while next_offset skipped past their items.
  for (const args of [
    { date: '01-01', window_days: 7, limit_per_year: 20 },
    { date: '01-01', window_days: 3, limit_per_year: 20 }
  ]) {
    const seen = new Set();
    let repeats = 0;
    let total = null;
    let offset = 0;
    let capped = false;
    for (let page = 0; page < 40; page += 1) {
      const result = await call('on_this_day', { ...args, ...(offset ? { offset } : {}) });
      total = result.total_count;
      if (result.truncated?.max_chars) capped = true;
      for (const row of result.years || []) {
        for (const item of row.items || []) {
          const key = `${row.year}|${item.id}|${item.date}|${item.url || ''}|${item.title || ''}`;
          if (seen.has(key)) repeats += 1;
          seen.add(key);
        }
      }
      offset = result.truncated?.next_offset;
      if (!offset) break;
    }
    const label = `completeness on_this_day ${args.date} window ${args.window_days} walk`;
    check(`${label} was capped`, capped, 'raise the window if the cap no longer bites');
    check(`${label} reaches total_count`, seen.size === total, `${seen.size} vs ${total}`);
    check(`${label} repeats nothing`, repeats === 0, `${repeats} repeats`);
  }

  // 2c. Every source a listing tool emits carries date, the Chicago day it
  //     was published, and the full newest-first walks never step forward a
  //     day (QA2 T2-5: only on_this_day showed the Chicago day; 125 sources
  //     showed a UTC or permalink day, and ep-1's bare date sorted as UTC
  //     midnight, the Chicago evening before).
  {
    const walk = async (tool, args, key = 'results') => {
      const items = [];
      let offset = 0;
      for (let guard = 0; guard < 1000; guard += 1) {
        const result = await call(tool, { ...args, ...(offset ? { offset } : {}) });
        items.push(...(result[key] || []));
        offset = result.truncated?.next_offset;
        if (!offset) return { items, total: result.total_count };
      }
      return { items, total: -1 };
    };
    // An undated page shows no date, and its oracle day is empty.
    const misdated = (items, idOf = (item) => item.id) =>
      items
        .filter((item) => (item.date ?? '') !== (oracleDay.get(idOf(item)) ?? ''))
        .map((item) => `${idOf(item)} ${item.date}`);
    // The day a reader sees: date, or what showed before it (publish_date).
    const shownDay = (item) => String(item.date ?? item.publish_date ?? '').slice(0, 10);
    const stepsForward = (items) => items.filter((item, i) => i > 0 && shownDay(item) > shownDay(items[i - 1]));
    for (const [tool, limit] of [
      ['list_content', 120],
      ['latest_content', 30]
    ]) {
      const { items, total } = await walk(tool, { limit });
      const wrong = misdated(items);
      const forward = stepsForward(items.filter((item) => shownDay(item)));
      // list_content is the catalogue (undated pages last); latest_content
      // is by date, so it holds every dated source and no page.
      const expected = tool === 'latest_content' ? totalItems - undatedItems.length : totalItems;
      check(
        `completeness ${tool} walk reaches every source`,
        items.length === total && total === expected,
        `${items.length} of ${total} (${expected})`
      );
      if (tool === 'list_content') {
        const firstUndated = items.findIndex((item) => !shownDay(item));
        check(
          'completeness list_content lists undated pages after every dated source',
          firstUndated === -1 || items.slice(firstUndated).every((item) => !shownDay(item)),
          `first undated at ${firstUndated} of ${items.length}`
        );
      }
      check(
        `completeness ${tool} dates every source in Chicago`,
        wrong.length === 0,
        `${wrong.length}: ${wrong.slice(0, 4).join('; ')}`
      );
      check(
        `completeness ${tool} walk never steps forward a day`,
        forward.length === 0,
        `${forward.length}: ${forward
          .slice(0, 4)
          .map((item) => `${item.id} ${shownDay(item)}`)
          .join('; ')}`
      );
    }
    const quoted = await walk('quote_search', { phrase: 'good morning', limit: 50 });
    const quotedWrong = misdated(quoted.items);
    check(
      'completeness quote_search dates every source in Chicago',
      quoted.items.length > 0 && quotedWrong.length === 0,
      `${quoted.items.length} items; ${quotedWrong.length}: ${quotedWrong.slice(0, 4).join('; ')}`
    );
    const sourcesWrong = [];
    for (const id of ['wt-22', 'wt-35', 'wt-299', 'wt-251', 'blog-20021', 'blog-1077238', 'ep-1']) {
      const source = (await call('get_source', { id, limit: 1 })).source || {};
      if (source.date !== oracleDay.get(id)) sourcesWrong.push(`${id} ${source.date} (oracle ${oracleDay.get(id)})`);
    }
    check('completeness get_source dates each source in Chicago', sourcesWrong.length === 0, sourcesWrong.join('; '));
    // 3. currently_history reaches every Currently entry, each on its
    //    issue's Chicago day.
    const currently = await walk('currently_history', { limit: 120 }, 'entries');
    const oracle = (wt.currently || []).length;
    check('completeness currently_history total', currently.total === oracle, `${currently.total} vs ${oracle}`);
    const entriesWrong = misdated(currently.items, (entry) => entry.source_id);
    check(
      'completeness currently_history dates every entry in Chicago',
      currently.items.length === oracle && entriesWrong.length === 0,
      `${currently.items.length} entries; ${entriesWrong.length}: ${entriesWrong.slice(0, 4).join('; ')}`
    );
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
    // Undated pages are in the total and in no year.
    let parts = Number(all.undated_count) || 0;
    for (let year = 2000; year <= new Date().getUTCFullYear(); year += 1) {
      parts += Number((await call(tool, { ...args, year, limit: 1 })).total_count) || 0;
    }
    check(
      `completeness ${tool} years + undated_count sum to total`,
      all.total_count === parts,
      `${all.total_count} vs ${parts}`
    );
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
      const byId = await call('get_source', { id: blogId(post), format: 'outline' });
      if (byId.source?.subject !== post.subject) missing.push(blogId(post));
      const byUrl = await call('get_source', { id: post.url, format: 'outline' });
      if (urlCounts.get(post.url) > 1) {
        const named = new Set((byUrl.candidates || []).map((candidate) => candidate.id));
        const expected = posts.filter((item) => item.url === post.url).map(blogId);
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
      // blog:<id> or page:<id> - pages number apart from posts.
      const id = String(chunk.id || '')
        .split(':')
        .slice(0, 2)
        .join(':');
      ownWords.set(id, (ownWords.get(id) || 0) + (Number(chunk.word_count) || 0));
    }
    const merged = [];
    for (const post of posts.filter((item) => urlCounts.get(item.url) > 1 && item.microblog_id != null)) {
      const result = await call('get_source', { id: `blog-${post.microblog_id}`, format: 'outline' });
      const words = Number(result.source?.word_count) || 0;
      const own = ownWords.get(`blog:${post.microblog_id}`) || 0;
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

    // Every paragraph under a heading is in that section's read, page by
    // page (QA2 R2-1: 107 headings read partial, an exact row winning over
    // the H2's extent; wt-146 Stream returned 95 of 9,099 chars).
    const fold = (text) =>
      String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const readSection = async (id, section, folded = true) => {
      let offset = 0;
      let text = '';
      for (let page = 0; page < 20; page += 1) {
        const result = await call('get_source', {
          id,
          format: 'text',
          ...(section === undefined ? {} : { section }),
          ...(offset ? { offset } : {})
        });
        if (result.error) return null;
        text += String(result.source?.body || '');
        offset = result.truncated?.next_offset || 0;
        if (!offset) break;
      }
      return folded ? fold(text) : text;
    };
    const underHeadings = (body, pattern) => {
      const lines = String(body || '').split('\n');
      const heads = [];
      let fenced = false;
      lines.forEach((line, index) => {
        if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
        const heading = !fenced && /^(#{1,6})\s+(.*?)\s*$/.exec(line);
        if (heading) heads.push({ index, level: heading[1].length, name: heading[2] });
      });
      return heads
        .filter((head) => pattern.test('#'.repeat(head.level)))
        .map((head) => {
          const next = heads.find((other) => other.index > head.index && other.level <= head.level);
          const paragraphs = lines
            .slice(head.index + 1, next ? next.index : lines.length)
            .join('\n')
            .split(/\n\s*\n/)
            .map(fold)
            .filter((paragraph) => paragraph.length >= 30 && !/^#{1,6}\s/.test(paragraph));
          return { name: head.name, paragraphs };
        });
    };
    const partial = [];
    let headings = 0;
    let missingParagraphs = 0;
    for (const issue of bySource.weekly_thing.items) {
      for (const { name, paragraphs } of underHeadings(issue.body, /^#{2,3}$/)) {
        headings += 1;
        const text = await readSection(`wt-${issue.number}`, name);
        const missing = text === null ? paragraphs.length || 1 : paragraphs.filter((p) => !text.includes(p)).length;
        if (missing || !text) {
          missingParagraphs += missing;
          partial.push(`wt-${issue.number} "${name}" ${missing}`);
        }
      }
    }
    check(
      'completeness every body heading reads whole as a section',
      headings > 0 && partial.length === 0,
      `${partial.length} of ${headings} (${missingParagraphs} paragraphs): ${partial.slice(0, 4).join(', ')}`
    );
    // The same for every heading in a blog post, outside fenced code (QA2
    // R2-5: a "#" comment in a code fence ended the read). The post's own
    // whole read is the oracle body: its chunks overlap, so joining them
    // would repeat text.
    const blogPartial = [];
    let blogHeadings = 0;
    const chunksOfPost = new Map();
    for (const chunk of blog.chunks || []) {
      const key =
        chunk.page_id != null
          ? `page-${chunk.page_id}`
          : `blog-${chunk.microblog_id ?? /^blog:(\d+):/.exec(String(chunk.id || ''))?.[1] ?? ''}`;
      if (!chunksOfPost.has(key)) chunksOfPost.set(key, []);
      chunksOfPost.get(key).push(chunk);
    }
    for (const [id, chunks] of chunksOfPost) {
      if (!chunks.some((chunk) => /^#{1,6}\s/m.test(String(chunk.text || '')))) continue;
      const text = await readSection(id, undefined, false);
      if (text === null) {
        blogPartial.push(`${id} unreadable`);
        continue;
      }
      for (const { name, paragraphs } of underHeadings(text, /^#{1,6}$/)) {
        blogHeadings += 1;
        const read = await readSection(id, name);
        const missing = read === null ? paragraphs.length || 1 : paragraphs.filter((p) => !read.includes(p)).length;
        if (missing) blogPartial.push(`${id} "${name}" ${missing}`);
      }
    }
    check(
      'completeness every blog heading reads whole as a section',
      blogHeadings > 0 && blogPartial.length === 0,
      `${blogPartial.length} of ${blogHeadings}: ${blogPartial.slice(0, 4).join(', ')}`
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

  // 8f. quote_search finds a verbatim phrase whatever emoji it crosses
  //     (QA2 L2-1): the selector after an emoji (⚽ + U+FE0F) once ended
  //     every match, so 86 of 86 "word, emoji, word" phrases read as absent.
  {
    const missed = [];
    let asked = 0;
    for (const issue of (wt.issues || []).filter((item) => /\uFE0F\s+\p{L}/u.test(item.body || ''))) {
      if (asked >= 25) break;
      const phrase = String(issue.body).match(/\p{L}+[.,!]? \S*\uFE0F\S*\s+\p{L}{3,}/u)?.[0];
      if (!phrase) continue;
      asked += 1;
      const result = await call('quote_search', { phrase, year: yearOf(issue) });
      if (!(result.results || []).some((row) => row.id === `wt-${issue.number}`)) {
        missed.push(`wt-${issue.number}: ${phrase}`);
      }
    }
    check(
      'completeness quote_search crosses emoji variation selectors',
      asked === 25 && missed.length === 0,
      `${missed.length} of ${asked} missed: ${missed.slice(0, 4).join(' | ')}`
    );
  }

  // 8g. A Journal copy is a post from the issue's own week, never an older
  //     post Jamie linked to in Journal prose (QA2 I2-1: five passages of new
  //     writing were dropped as "copies" of 2016-2023 posts). The oracle
  //     finds every pairing whose post's day (Chicago or permalink) falls
  //     outside [previous issue - 3 days, issue + 1 day]; with those posts in
  //     the pool the passage stays, and copy_of never names them.
  {
    const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
    const dayOf = (stamp) => {
      const value = String(stamp || '');
      return /T/.test(value) && Number.isFinite(Date.parse(value))
        ? chicago.format(Date.parse(value))
        : value.slice(0, 10);
    };
    const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const postDays = new Map(
      (blog.posts || []).map((post) => [
        String(post.microblog_id),
        [dayOf(post.published), String(post.publish_date || '').slice(0, 10), post.permalink_date].filter(Boolean)
      ])
    );
    const issueDays = (wt.issues || [])
      .map((issue) => [String(issue.number), dayOf(issue.publish_date)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    const weeks = new Map(
      issueDays.map(([number, day], index) => [
        number,
        [index ? shift(issueDays[index - 1][1], -3) : '0000-00-00', shift(day, 1)]
      ])
    );
    let stalePairs = 0;
    const wrong = [];
    for (const chunk of wt.chunks || []) {
      const week = weeks.get(String(chunk.issue_number));
      const stale = (chunk.journal_posts || []).filter((copy) => {
        const days = postDays.get(String(copy?.copy_of_microblog_id));
        return week && days?.length && days.every((day) => day < week[0] || day > week[1]);
      });
      if (!stale.length) continue;
      stalePairs += stale.length;
      // Every passage of each post, so the per-passage twin test (QA3 Q7)
      // cannot be what keeps the copy.
      const posts = stale.flatMap((copy) => {
        const passages = (blog.chunks || []).filter(
          (passage) => String(passage.microblog_id) === String(copy.copy_of_microblog_id)
        );
        return passages.length
          ? passages
          : [
              {
                id: `blog:${copy.copy_of_microblog_id}:0:x`,
                source_kind: 'blog',
                microblog_id: copy.copy_of_microblog_id,
                url: copy.canonical_url || copy.url
              }
            ];
      });
      const kept = retrieval.dedupeJournalTwins?.([chunk, ...posts]).includes(chunk);
      const named = (retrieval.journalCopyPosts?.(chunk) || chunk.journal_posts).filter((copy) => stale.includes(copy));
      if (!kept || named.length) wrong.push(`wt-${chunk.issue_number} "${chunk.section}"${kept ? '' : ' dropped'}`);
    }
    check(
      'completeness a Journal copy is from the issue week',
      wrong.length === 0,
      `${wrong.length} of ${stalePairs} out-of-week pairings honoured: ${wrong.slice(0, 5).join(', ')}`
    );
  }

  // 8h. Every issue a topic cluster files is reachable by search_archive's
  //     topic filter: at least one of its passages passes the filter (QA2
  //     L2-7: the filter read only per-passage labels, and 250 issue
  //     filings across seven clusters had no labelled passage).
  {
    const passagesOf = new Map();
    for (const chunk of wt.chunks || []) {
      const key = String(chunk.issue_number);
      if (!passagesOf.has(key)) passagesOf.set(key, []);
      passagesOf.get(key).push(chunk);
    }
    const unreachable = [];
    let filings = 0;
    for (const cluster of wt.topics || []) {
      for (const number of cluster.issue_numbers || []) {
        filings += 1;
        const passages = passagesOf.get(String(number)) || [];
        if (!passages.some((chunk) => retrieval.matchesFilters?.(chunk, { topic: cluster.name }))) {
          unreachable.push(`${cluster.name} wt-${number}`);
        }
      }
    }
    check(
      'completeness every issue a topic cluster files is reachable by the topic filter',
      filings > 0 && unreachable.length === 0,
      `${unreachable.length} of ${filings}: ${unreachable.slice(0, 4).join(', ')}`
    );
  }

  // 8i. voice=jamie in archive_lens keeps every blog post whose own words
  //     name the topic, however short (QA2 lexical L2-3: a 40-character
  //     floor hid "Just landed in Minneapolis!", blog-805918). The oracle
  //     reads Jamie's spans (the whole text when a chunk has none) with
  //     images and link targets removed, and matches the whole word.
  {
    const ownWords = (chunk) => {
      const text = String(chunk.text || '');
      const parts = Array.isArray(chunk.spans)
        ? chunk.spans.filter((span) => span.voice === 'jamie').map((span) => text.slice(span.start, span.end))
        : [text];
      return parts
        .join('\n\n')
        .replace(/!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi, ' ')
        .replace(/\]\([^)]*\)/g, '] ')
        .replace(/https?:\/\/\S+/g, ' ');
    };
    for (const topic of ['Minneapolis', 'iPhone', 'Tesla']) {
      const pattern = new RegExp(`\\b${topic}\\b`, 'i');
      const oracle = new Set(
        (blog.chunks || [])
          .filter((chunk) => chunk.publish_date && pattern.test(ownWords(chunk)))
          .map((chunk) => String(chunk.microblog_id))
      );
      const lens = await call('archive_lens', { topic, voice: 'jamie', source_kind: 'blog', limit: 1 });
      check(
        `completeness archive_lens voice=jamie ${topic} counts every post in Jamie's words`,
        lens.total_count === oracle.size,
        `${lens.total_count} vs ${oracle.size}`
      );
    }
    const year = await call('archive_lens', {
      topic: 'Minneapolis',
      voice: 'jamie',
      source_kind: 'blog',
      year: 2008,
      limit: 40
    });
    const ids = [];
    for (let offset = 0, page = year; ;) {
      ids.push(...(page.results || []).map((ref) => (typeof ref === 'string' ? ref : ref.id)));
      offset = page.truncated?.next_offset || 0;
      if (!offset) break;
      page = await call('archive_lens', {
        topic: 'Minneapolis',
        voice: 'jamie',
        source_kind: 'blog',
        year: 2008,
        limit: 40,
        offset
      });
    }
    check('completeness archive_lens voice=jamie keeps a short post (blog-805918)', ids.includes('blog-805918'));
  }

  // 8j. archive_lens years[].top_domains counts links, not documents: each
  //     year's Weekly Thing headline links to other sites from the matched
  //     issues, by host with www merged, and domain_count says how many
  //     hosts the six are of (QA2 links L9, L10: Mastodon 2023 showed 6 of
  //     81 with no count, and www.macstories.net apart from macstories.net).
  {
    const chicagoYear = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' });
    const issueYear = new Map(
      bySource.weekly_thing.items.map((issue) => [
        `wt-${issue.number}`,
        Number(chicagoYear.format(new Date(issue.publish_date)))
      ])
    );
    for (const topic of ['Mastodon', 'RSS']) {
      const matched = new Set();
      let first;
      for (let offset = 0; ;) {
        const page = await call('archive_lens', {
          topic,
          source_kind: 'weekly_thing',
          limit: 40,
          ...(offset ? { offset } : {})
        });
        first = first || page;
        for (const ref of page.results || []) matched.add(typeof ref === 'string' ? ref : ref.id);
        offset = page.truncated?.next_offset || 0;
        if (!offset) break;
      }
      const oracle = new Map();
      for (const link of bySource.weekly_thing.links) {
        const id = `wt-${link.issue_number}`;
        if (!matched.has(id) || (link.link_role && link.link_role !== 'headline')) continue;
        const host = hostOf(link.url).replace(/^www\./, '');
        if (!host || host === 'thingelstad.com' || host.endsWith('.thingelstad.com')) continue;
        const year = issueYear.get(id);
        if (!oracle.has(year)) oracle.set(year, new Map());
        oracle.get(year).set(host, (oracle.get(year).get(host) || 0) + 1);
      }
      const wrong = [];
      // Every year's cut, the years compaction dropped included.
      const omitted = [...oracle.values()].reduce((sum, hosts) => sum + Math.max(0, hosts.size - 6), 0);
      for (const row of first.years || []) {
        const hosts = oracle.get(row.year) || new Map();
        const want = [...hosts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, row.top_domains.length || 6)
          .map(([domain, count]) => `${domain}:${count}`)
          .join(',');
        const got = row.top_domains.map((entry) => `${entry.domain}:${entry.count}`).join(',');
        if (row.domain_count !== hosts.size || got !== want) {
          wrong.push(`${row.year} ${row.domain_count}/${hosts.size} ${got} vs ${want}`);
        }
      }
      check(
        `completeness archive_lens ${topic} years[].top_domains count links by host`,
        (first.years || []).length > 0 && wrong.length === 0,
        wrong.slice(0, 3).join('; ')
      );
      check(
        `completeness archive_lens ${topic} omitted years[].top_domains is what the years leave out`,
        (first.truncated?.omitted?.['years[].top_domains'] || 0) === omitted,
        `${first.truncated?.omitted?.['years[].top_domains']} vs ${omitted}`
      );
    }
  }

  // 8k. A url finds every link to that page however its path was
  //     percent-encoded (QA2 links L2-1: Elf_%28film%29 found 0 of 8). Each
  //     spelling in a group of corpus links whose paths differ only in
  //     encoding finds the whole group.
  {
    const groups = new Map();
    for (const link of allLinks) {
      let parsed;
      let path;
      try {
        parsed = new URL(String(link.url));
        path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
      } catch {
        continue;
      }
      const key = `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${path}${parsed.search}`;
      const group = groups.get(key) || { size: 0, spellings: new Map() };
      group.size += 1;
      const spelling = parsed.pathname.replace(/\/+$/, '');
      if (!group.spellings.has(spelling)) group.spellings.set(spelling, link.url);
      groups.set(key, group);
    }
    const split = [...groups].filter(([, group]) => group.spellings.size > 1);
    const short = [];
    for (const [key, group] of split) {
      for (const url of group.spellings.values()) {
        const found = await call('find_links', { url, limit: 1 });
        if (found.total_count !== group.size) short.push(`${key} ${url} ${found.total_count}/${group.size}`);
      }
    }
    check(
      'completeness find_links url finds every encoding of a path',
      split.length > 0 && short.length === 0,
      `${short.length} spellings short across ${split.length} groups: ${short.slice(0, 3).join('; ')}`
    );
    const pins = [
      ['https://en.wikipedia.org/wiki/Elf_%28film%29', 8],
      ['https://en.wikipedia.org/wiki/Elf_(film)', 8],
      // 8 since WT352 (2026-10-04) linked them again for the fall.
      ['https://en.wikipedia.org/wiki/The_Replacements_(band)', 8],
      ['https://en.wikipedia.org/wiki/The_Replacements_%28band%29', 8],
      ["https://en.wikipedia.org/wiki/Dunbar's_number", 4],
      ['https://en.wikipedia.org/wiki/Dunbar%27s_number', 4],
      ['https://en.wikipedia.org/wiki/M%c3%b6lkky', 4]
    ];
    const off = [];
    for (const [url, want] of pins) {
      const found = await call('find_links', { url, limit: 1 });
      if (found.total_count !== want) off.push(`${url} ${found.total_count}/${want}`);
    }
    // Fixed counts, so a new issue that links one moves them: before the
    // gate they read the live corpora the rebuild has not reached yet.
    checkCorpus('completeness find_links url encoding pins', off.length === 0, off.join('; '));
  }

  // 8l. A site page's incoming_count is every corpus link to its url (QA2
  //     links L2-2: site-members said 0; wt-347 and wt-348 link it).
  {
    const pages = new Set(
      (wt.chunks || [])
        .filter((chunk) => ['site_page', 'faq'].includes(chunk.source_kind) && /^\//.test(String(chunk.url || '')))
        .map((chunk) => String(chunk.url).replace(/\/+$/, ''))
    );
    const wrong = [];
    for (const page of pages) {
      const want = allLinks.filter((link) => {
        const host = hostOf(link.url).replace(/^www\./, '');
        let path = '';
        try {
          path = new URL(String(link.url)).pathname.replace(/\/+$/, '');
        } catch {
          return false;
        }
        return host === 'weekly.thingelstad.com' && path === page;
      }).length;
      const near = await call('source_neighborhood', { id: `site-${page.split('/').at(-1)}` });
      if (near.incoming_count !== want) wrong.push(`site-${page.split('/').at(-1)} ${near.incoming_count}/${want}`);
    }
    check(
      'completeness site pages count every link to them',
      pages.size > 0 && wrong.length === 0,
      `${pages.size} pages: ${wrong.join(', ')}`
    );
    const members = await call('source_neighborhood', { id: 'site-members' });
    check('completeness site-members incoming_count 2', members.incoming_count === 2, String(members.incoming_count));
  }

  // 8m. Where a blog post appears in The Weekly Thing, two lists (Jamie,
  //     2026-10-01; QA2 I2-1, links Q1): also_in_issues, the issues whose
  //     Journal reprints the post from the issue's own week; and
  //     linked_from_issues, every other issue that links it (a pick, prose,
  //     a Journal link to an older post). The oracle reads the raw corpora:
  //     reprints from the Weekly Thing chunks' journal_posts inside
  //     [previous issue - 3 days, issue + 1 day] (Chicago or permalink day,
  //     as 8g), links from the Weekly Thing links whose url names the
  //     post's permalink (two posts can share one). Every issue lands in
  //     exactly one list, and none is dropped, on corpora built before the
  //     split and after it.
  {
    const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
    const dayOf = (stamp) => {
      const value = String(stamp || '');
      return /T/.test(value) && Number.isFinite(Date.parse(value))
        ? chicago.format(Date.parse(value))
        : value.slice(0, 10);
    };
    const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const postDays = new Map(
      (blog.posts || []).map((post) => [
        String(post.microblog_id),
        [dayOf(post.published), String(post.publish_date || '').slice(0, 10)].filter(Boolean)
      ])
    );
    const issueDays = (wt.issues || [])
      .map((issue) => [String(issue.number), dayOf(issue.publish_date)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    const weeks = new Map(
      issueDays.map(([number, day], index) => [
        number,
        [index ? shift(issueDays[index - 1][1], -3) : '0000-00-00', shift(day, 1)]
      ])
    );
    const add = (map, key, issue) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(String(issue));
    };
    const reprinted = new Map();
    for (const chunk of wt.chunks || []) {
      const week = weeks.get(String(chunk.issue_number));
      for (const copy of chunk.journal_posts || []) {
        if (copy?.copy_of_microblog_id == null) continue;
        const days = postDays.get(String(copy.copy_of_microblog_id)) || [];
        if (!week || !days.length || days.some((day) => day >= week[0] && day <= week[1])) {
          add(reprinted, String(copy.copy_of_microblog_id), chunk.issue_number);
        }
      }
    }
    const permalink = (url) => {
      const match =
        /^https?:\/\/(?:www\.|micro\.)?(?:thingelstad\.com|jthingelstad\.micro\.blog)\/(\d{4}\/\d{2}\/\d{2}\/[^?#]+?)(?:\.html)?\/?(?:[?#].*)?$/i.exec(
          String(url || '').trim()
        );
      return match ? match[1].toLowerCase() : '';
    };
    const postsAt = new Map();
    for (const post of blog.posts || []) {
      const key = post.microblog_id == null ? '' : permalink(post.url);
      if (key) postsAt.set(key, [...(postsAt.get(key) || []), String(post.microblog_id)]);
    }
    const named = new Map();
    for (const link of wt.links || []) {
      for (const id of postsAt.get(permalink(link.url)) || []) add(named, id, link.issue_number);
    }
    for (const [id, issues] of reprinted) for (const issue of issues) add(named, id, issue);
    const sorted = (values) => [...(values || [])].map(String).sort().join(',');
    // Each post is read once per list it is in; both reads show both lists.
    const got = new Map();
    for (const filter of ['has_also_in_issues', 'has_linked_from_issues']) {
      for (let offset = 0; offset !== undefined;) {
        const page = await call('list_content', { source_kind: 'blog', [filter]: true, limit: 120, offset });
        for (const row of page.results || []) {
          got.set(row.id, { also: sorted(row.also_in_issues), linked: sorted(row.linked_from_issues) });
        }
        offset = page.truncated?.next_offset;
      }
    }
    const wrong = [];
    let pairs = 0;
    for (const [id, issues] of named) {
      pairs += issues.size;
      const want = {
        also: sorted(reprinted.get(id)),
        linked: sorted([...issues].filter((issue) => !reprinted.get(id)?.has(issue)))
      };
      const have = got.get(`blog-${id}`) || { also: '', linked: '' };
      if (have.also !== want.also || have.linked !== want.linked) {
        wrong.push(
          `blog-${id} also ${have.also || '-'}/${want.also || '-'} linked ${have.linked || '-'}/${want.linked || '-'}`
        );
      }
    }
    const extra = [...got.keys()].filter((id) => !named.has(id.replace(/^blog-/, '')));
    check(
      'completeness also_in_issues and linked_from_issues partition the issues naming each post',
      named.size > 0 && wrong.length === 0 && extra.length === 0,
      `${named.size} posts, ${pairs} pairs: ${wrong.length} wrong (${wrong.slice(0, 4).join('; ')}), ${extra.length} extra (${extra.slice(0, 4).join(', ')})`
    );
  }

  // 9. Corpus size into the baseline: a build that drops more than 10% of
  //    the sources or links fails the band even when every tool is honest.
  counts.corpus_items = totalItems;
  counts.corpus_links = allLinks.length;
  // Every source but a thingelstad.com page has a date.
  const undated = undatedItems.filter((item) => item.page_id == null);
  check(
    'completeness every source but a page is dated',
    undated.length === 0,
    undated
      .slice(0, 5)
      .map((item) => item.url)
      .join(', ')
  );
}
