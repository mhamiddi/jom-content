import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFromInsights, pageSize, threadItemFromApi } from '../functions/_lib/threads-analytics.mjs';

test('caps one API collection page below the Cloudflare subrequest limit', () => {
  assert.equal(pageSize(5), 5);
  assert.equal(pageSize(40), 40);
  assert.equal(pageSize(500), 40);
});

test('maps official Threads insight payload into dashboard metric fields', () => {
  const payload = {
    data: [
      { name: 'views', values: [{ value: 1234 }] },
      { name: 'likes', values: [{ value: 42 }] },
      { name: 'replies', values: [{ value: 7 }] },
      { name: 'reposts', values: [{ value: 3 }] },
      { name: 'quotes', values: [{ value: 2 }] },
      { name: 'shares', values: [{ value: 5 }] },
    ],
  };

  assert.deepEqual(metricsFromInsights(payload), {
    views: 1234,
    likes: 42,
    comments: 7,
    shares: 5,
    quotes: 2,
    saves: null,
    interactions: 59,
  });
});

test('keeps unavailable metrics as null and never turns them into zero', () => {
  const payload = { data: [{ name: 'likes', values: [{ value: 2 }] }] };
  const metrics = metricsFromInsights(payload);
  assert.equal(metrics.views, null);
  assert.equal(metrics.comments, null);
  assert.equal(metrics.shares, null);
  assert.equal(metrics.interactions, 2);
});

test('normalizes an owned Threads post for the existing analytics database', () => {
  const item = threadItemFromApi({
    id: 'post-123',
    text: 'Test post',
    timestamp: '2026-10-25T01:00:00+0000',
    permalink: 'https://www.threads.com/@hamiddi_/post/post-123',
  }, { data: [{ name: 'views', values: [{ value: 10 }] }, { name: 'likes', values: [{ value: 2 }] }] });

  assert.deepEqual(item, {
    platform: 'threads',
    platform_content_id: 'post-123',
    url: 'https://www.threads.com/@hamiddi_/post/post-123',
    content_text: 'Test post',
    published_at: '2026-10-25T01:00:00+0000',
    duration_seconds: null,
    content_type: 'thread_post',
    parent_platform_content_id: null,
    metrics: {
      views: 10,
      likes: 2,
      comments: null,
      shares: null,
      saves: null,
      quotes: null,
      interactions: 2,
    },
  });
});
