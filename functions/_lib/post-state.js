export const POST_STATES = Object.freeze([
  'draft',
  'approved',
  'scheduled',
  'publishing',
  'posted',
  'partial',
  'failed',
  'reconciliation_required',
  'rejected',
]);

const STATUS_ALIASES = Object.freeze({
  published: 'posted',
  done: 'posted',
  complete: 'posted',
  queued: 'scheduled',
});
const TRANSITIONS = Object.freeze({
  draft: new Set(['draft', 'approved', 'scheduled', 'publishing', 'rejected']),
  approved: new Set(['approved', 'draft', 'scheduled', 'publishing', 'rejected']),
  scheduled: new Set(['scheduled', 'draft', 'approved', 'publishing', 'rejected']),
  publishing: new Set(['publishing', 'posted', 'partial', 'failed', 'reconciliation_required']),
  posted: new Set(['posted', 'publishing']),
  partial: new Set(['partial', 'publishing', 'failed', 'reconciliation_required']),
  failed: new Set(['failed', 'draft', 'publishing', 'reconciliation_required']),
  reconciliation_required: new Set(['reconciliation_required', 'publishing', 'posted', 'failed']),
  rejected: new Set(['rejected', 'draft']),
});

export function canonicalPostStatus(value, fallback = 'draft') {
  const raw = String(value || '').trim().toLowerCase();
  const status = STATUS_ALIASES[raw] || raw || fallback;
  if (!POST_STATES.includes(status)) throw new Error('invalid_post_status');
  return status;
}

export function canTransitionPost(from, to) {
  const current = canonicalPostStatus(from);
  const next = canonicalPostStatus(to);
  return TRANSITIONS[current].has(next);
}

export function transitionPost(post, nextStatus, metadata = {}) {
  const current = canonicalPostStatus(post?.status);
  const next = canonicalPostStatus(nextStatus);
  if (current !== next && !canTransitionPost(current, next)) {
    throw new Error(`invalid_post_transition:${current}->${next}`);
  }
  if (current === next) return { ...post, status: next };

  const now = metadata.at || new Date().toISOString();
  const event = {
    from: current,
    to: next,
    at: now,
    ...(metadata.actor ? { actor: String(metadata.actor).slice(0, 64) } : {}),
    ...(metadata.platform ? { platform: String(metadata.platform).slice(0, 64) } : {}),
    ...(metadata.accountId ? { accountId: String(metadata.accountId).slice(0, 128) } : {}),
  };
  const history = Array.isArray(post?.statusHistory) ? post.statusHistory : [];
  return {
    ...post,
    status: next,
    statusChangedAt: now,
    statusHistory: [...history, event].slice(-30),
  };
}

export async function updateStoredPostStatus(env, postId, nextStatus, metadata = {}) {
  if (!env?.JOM_CONTENT) throw new Error('KV binding not available');
  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const index = posts.findIndex((item) => item && item.id === postId);
  if (index === -1) return null;
  posts[index] = transitionPost(posts[index], nextStatus, metadata);
  await env.JOM_CONTENT.put('posts', JSON.stringify(posts));
  return posts[index];
}
