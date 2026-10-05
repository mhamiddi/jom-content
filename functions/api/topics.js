/**
 * Jom Content API — Daily Topic Bank
 * Cloudflare Pages Function backed by the existing JOM_CONTENT KV namespace.
 *
 * GET  /api/topics
 * POST /api/topics       { runId, suggestedDate, topics: [...] }
 * PUT  /api/topics?id=ID { feedback, feedbackNote, published, ... }
 */

const KV_KEY = 'topic_bank';
const CANONICAL_PILLARS = ['Google Ads & Marketing', 'Agentic AI', 'Engage'];
const ALLOWED_FEEDBACK = new Set(['up', 'down', null, '']);
const PILLAR_ALIASES = {
  'google ads': 'Google Ads & Marketing',
  'google ads & marketing': 'Google Ads & Marketing',
  'digital marketing': 'Google Ads & Marketing',
  'website leads': 'Google Ads & Marketing',
  'website-cro': 'Google Ads & Marketing',
  'website cro': 'Google Ads & Marketing',
  'hermes agentic ai': 'Agentic AI',
  'agentic ai': 'Agentic AI',
  'personal': 'Engage',
  'personal & mindset': 'Engage',
  'others': 'Engage',
};
function canonicalPillar(value) {
  const label = String(value || '').trim();
  return PILLAR_ALIASES[label.toLowerCase().replace(/[-_]+/g, ' ')] || PILLAR_ALIASES[label.toLowerCase()] || label || 'Engage';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normaliseTopic(raw, fallback = {}) {
  const now = nowIso();
  const topic = {
    id: String(raw.id || crypto.randomUUID()),
    runId: String(raw.runId || fallback.runId || ''),
    suggestedDate: String(raw.suggestedDate || fallback.suggestedDate || now.slice(0, 10)),
    suggestedAt: raw.suggestedAt || fallback.suggestedAt || now,
    rank: Number(raw.rank || 0),
    topic: String(raw.topic || raw.title || '').trim(),
    angle: String(raw.angle || '').trim(),
    pillar: canonicalPillar(raw.pillar || 'Engage'),
    why: String(raw.why || '').trim(),
    source: String(raw.source || '').trim(),
    sourceUrl: String(raw.sourceUrl || '').trim(),
    pattern: String(raw.pattern || '').trim(),
    hook: String(raw.hook || '').trim(),
    feedback: ALLOWED_FEEDBACK.has(raw.feedback) ? (raw.feedback || null) : null,
    feedbackNote: String(raw.feedbackNote || '').trim(),
    published: Boolean(raw.published),
    publishedAt: raw.publishedAt || null,
    publishedUrl: String(raw.publishedUrl || '').trim(),
    contentNote: String(raw.contentNote || '').trim(),
    createdAt: raw.createdAt || now,
    updatedAt: now,
  };
  if (!topic.topic) throw new Error('topic is required');
  return topic;
}

async function readTopics(kv) {
  const raw = await kv.get(KV_KEY, { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

function filterTopics(topics, url) {
  const date = url.searchParams.get('date');
  const feedback = url.searchParams.get('feedback');
  const published = url.searchParams.get('published');
  const pillar = url.searchParams.get('pillar');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  return topics.filter((item) => {
    if (date && item.suggestedDate !== date) return false;
    if (feedback && (item.feedback || 'none') !== feedback) return false;
    if (published === 'true' && !item.published) return false;
    if (published === 'false' && item.published) return false;
    if (pillar && canonicalPillar(item.pillar) !== canonicalPillar(pillar)) return false;
    if (q) {
      const haystack = [item.topic, item.angle, item.why, item.source, item.pillar, item.pattern, item.hook]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);

  try {
    const url = new URL(request.url);
    let topics = await readTopics(env.JOM_CONTENT);

    if (request.method === 'GET') {
      const filtered = filterTopics(topics, url).sort((a, b) => {
        const dateOrder = String(b.suggestedDate).localeCompare(String(a.suggestedDate));
        return dateOrder || Number(a.rank || 0) - Number(b.rank || 0);
      });
      const summary = {
        total: topics.length,
        unreviewed: topics.filter((x) => !x.feedback).length,
        liked: topics.filter((x) => x.feedback === 'up').length,
        disliked: topics.filter((x) => x.feedback === 'down').length,
        published: topics.filter((x) => x.published).length,
        dates: [...new Set(topics.map((x) => x.suggestedDate).filter(Boolean))].sort().reverse(),
        pillars: CANONICAL_PILLARS,
      };
      return json({ success: true, data: filtered.map((x) => ({ ...x, pillar: canonicalPillar(x.pillar) })), summary });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const incoming = Array.isArray(body.topics) ? body.topics : [body];
      const fallback = {
        runId: body.runId,
        suggestedDate: body.suggestedDate,
        suggestedAt: body.suggestedAt,
      };
      const byId = new Map(topics.map((item) => [String(item.id), item]));
      const saved = [];
      for (const raw of incoming) {
        const item = normaliseTopic(raw, fallback);
        const existing = byId.get(item.id);
        if (existing) {
          // Preserve user-owned feedback/publication fields on retry.
          item.feedback = existing.feedback;
          item.feedbackNote = existing.feedbackNote;
          item.published = existing.published;
          item.publishedAt = existing.publishedAt;
          item.publishedUrl = existing.publishedUrl;
          item.contentNote = existing.contentNote;
          item.createdAt = existing.createdAt;
        }
        byId.set(item.id, item);
        saved.push(item);
      }
      topics = [...byId.values()];
      await env.JOM_CONTENT.put(KV_KEY, JSON.stringify(topics));
      return json({ success: true, data: saved, count: saved.length }, 201);
    }

    if (request.method === 'PUT') {
      const id = url.searchParams.get('id');
      if (!id) return json({ success: false, error: 'id required' }, 400);
      const index = topics.findIndex((item) => String(item.id) === String(id));
      if (index === -1) return json({ success: false, error: 'Topic not found' }, 404);
      const body = await request.json();
      const allowed = ['feedback', 'feedbackNote', 'published', 'publishedAt', 'publishedUrl', 'contentNote'];
      for (const key of allowed) {
        if (body[key] === undefined) continue;
        if (key === 'feedback' && !ALLOWED_FEEDBACK.has(body[key])) {
          return json({ success: false, error: 'invalid feedback' }, 400);
        }
        topics[index][key] = key === 'feedbackNote' || key === 'publishedUrl' || key === 'contentNote'
          ? String(body[key] || '').trim()
          : body[key];
      }
      topics[index].updatedAt = nowIso();
      await env.JOM_CONTENT.put(KV_KEY, JSON.stringify(topics));
      return json({ success: true, data: topics[index] });
    }

    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (error) {
    const message = error.message || 'Unexpected error';
    const clientError = message === 'topic is required' || message.includes('topics must');
    return json({ success: false, error: message }, clientError ? 400 : 500);
  }
}
