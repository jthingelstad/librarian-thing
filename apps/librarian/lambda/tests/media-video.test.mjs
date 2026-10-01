import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

// QA3 (ingest I2-5): 4 blog videos have poster="" and had no media record.
// The corpus build now gives each one (media_kind "video", its url the
// video), findable by its post's words. view_photo cannot show a video, so
// media_search says so instead of offering it as a viewable photo.
const POST_URL = 'https://www.thingelstad.com/2009/06/08/learning-to-make.html';
const VIDEO = 'https://files.thingelstad.com/posts/2009/Sausage%20Making.m4v';
const POSTER = 'https://www.thingelstad.com/uploads/2024/c73eecb561.png';

function fixtures() {
  const base = {
    source_kind: 'blog',
    microblog_id: 1075505,
    subject: 'Learning to make sausage',
    source_url: POST_URL,
    publish_date: '2009-06-08'
  };
  return {
    weekly_thing: { issues: [], chunks: [], links: [], media: [] },
    blog: {
      post_count: 1,
      posts: [{ microblog_id: 1075505, subject: base.subject, publish_date: base.publish_date, url: POST_URL }],
      chunks: [],
      links: [],
      media: [
        {
          ...base,
          url: VIDEO,
          alt: '',
          context: 'Video with no poster still. We made sausage with Kent.',
          video_url: VIDEO,
          media_kind: 'video'
        },
        {
          ...base,
          url: POSTER,
          alt: '',
          context: 'Video poster, the still shown before the video plays. We made sausage with Kent.',
          video_url: `${VIDEO}.mov`,
          description: 'A grinder full of sausage'
        }
      ]
    },
    podcast: { episodes: [], chunks: [], links: [] }
  };
}

test('a posterless blog video is found by its post words and is not viewable', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.media_search({ query: 'sausage Kent' }, { scope: 'blog' });
  assert.equal(out.total_count, 2);
  const video = out.results.find((item) => item.image_url === VIDEO);
  assert.equal(video.media_kind, 'video');
  assert.equal(video.video_url, VIDEO);
  assert.equal(video.viewable, false);
  assert.equal(video.not_viewable_because, 'a video with no still image');
  assert.equal(video.described, false);
  const poster = out.results.find((item) => item.image_url === POSTER);
  assert.equal(poster.media_kind, undefined);
  assert.equal(poster.video_url, `${VIDEO}.mov`);
  assert.equal(poster.viewable, undefined);
});
