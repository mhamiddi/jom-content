const METRIC_NAMES = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function metricsFromInsights(payload) {
  const out = { views: null, likes: null, comments: null, shares: null, quotes: null, saves: null };
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const values = {};
  for (const row of rows) {
    const name = String(row?.name || '').toLowerCase();
    if (!METRIC_NAMES.includes(name)) continue;
    const first = Array.isArray(row?.values) ? row.values[0] : row?.value;
    values[name] = numeric(first?.value ?? first);
  }
  out.views = values.views ?? null;
  out.likes = values.likes ?? null;
  out.comments = values.replies ?? null;
  out.shares = values.shares ?? null;
  out.quotes = values.quotes ?? null;
  const interactionValues = [values.likes, values.replies, values.reposts, values.quotes, values.shares]
    .filter((value) => value !== null && value !== undefined);
  out.interactions = interactionValues.length ? interactionValues.reduce((sum, value) => sum + value, 0) : 0;
  return out;
}

export function threadItemFromApi(post, insights) {
  return {
    platform: 'threads',
    platform_content_id: String(post?.id || ''),
    url: String(post?.permalink || (post?.id ? `https://www.threads.net/@hamiddi_/post/${post.id}` : '')),
    content_text: String(post?.text || ''),
    published_at: post?.timestamp || null,
    duration_seconds: null,
    content_type: 'thread_post',
    parent_platform_content_id: null,
    metrics: metricsFromInsights(insights),
  };
}
