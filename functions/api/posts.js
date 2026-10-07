/**
 * Jom Content API — Posts
 * CF Pages Function
 * 
 * GET /api/posts — list all posts (with optional ?platform, ?status, ?pillar, ?month)
 * POST /api/posts — create new post
 * PUT /api/posts — update post (requires ?id=xxx or body.id)
 * DELETE /api/posts — delete post (requires ?id=xxx)
 * 
 * KV namespace: JOM_CONTENT
 * Key: "posts" — JSON array of all posts
 */

// What Middi actually posted (may differ from the suggested title/caption). Kept as plain strings.
const ACTUAL_FIELDS = ['actualTitle', 'actualContent', 'postedUrl'];
// Why a suggestion was rejected (Hermes analyses these every night). rejectedAt is set by the server.
const REJECT_MAX = 5000;
// Structured rejection reasons (keys such as too_short, generic, ai_tone). Free-form keys are allowed
// but must look like a slug, so the analysis can count them reliably.
const TAG_RE = /^[a-z][a-z_]{1,23}$/;
function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => TAG_RE.test(x)))].slice(0, 8);
}
function cleanReason(value) {
  return String(value == null ? '' : value).slice(0, REJECT_MAX).trim();
}
const ACTUAL_MAX = 20000;
function cleanActual(value) {
  return String(value == null ? '' : value).slice(0, ACTUAL_MAX).trim();
}

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

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const postsKV = env.JOM_CONTENT;
  if (!postsKV) {
    return new Response(JSON.stringify({ success: false, error: 'KV binding not available' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    // Read existing posts
    let posts = [];
    const raw = await postsKV.get('posts', { type: 'json' });
    if (raw && Array.isArray(raw)) posts = raw;

    const url = new URL(request.url);
    const postId = url.searchParams.get('id');

    // --- GET /api/posts (list all, with filters) ---
    if (request.method === 'GET') {
      const platform = url.searchParams.get('platform');
      const workspace = url.searchParams.get('workspace') || url.searchParams.get('client');
      const status = url.searchParams.get('status');
      const pillar = url.searchParams.get('pillar');
      const month = url.searchParams.get('month'); // YYYY-MM

      let filtered = [...posts];
      if (platform) filtered = filtered.filter(p => p.platform === platform);
      if (workspace) filtered = filtered.filter(p => (p.workspace || p.client || 'jom-digital') === workspace);
      if (status) filtered = filtered.filter(p => p.status === status);
      if (pillar) filtered = filtered.filter(p => canonicalPillar(p.pillar) === canonicalPillar(pillar));
      if (month) filtered = filtered.filter(p => p.date && p.date.startsWith(month));

      return new Response(JSON.stringify({ success: true, data: filtered.map(p => ({...p, pillar:canonicalPillar(p.pillar)})) }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // --- POST /api/posts (create) ---
    if (request.method === 'POST') {
      const body = await request.json();

      if (!body.title || !body.platform) {
        return new Response(JSON.stringify({ success: false, error: 'title and platform required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const validPlatforms = ['tiktok', 'threads'];
      if (!validPlatforms.includes(body.platform)) {
        return new Response(JSON.stringify({ success: false, error: 'invalid platform' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const newPost = {
        id: body.id || crypto.randomUUID(),
        title: body.title,
        platform: body.platform,
        workspace: body.workspace || body.client || 'jom-digital',
        client: body.client || body.workspace || 'jom-digital',
        caption: body.caption || '',
        pillar: canonicalPillar(body.pillar || 'Google Ads & Marketing'),
        date: body.date || '',
        time: body.time || '',
        status: body.status || 'draft',
        approved: body.approved || false,
        notes: body.notes || '',
        images: body.images || [],
        actualTitle: cleanActual(body.actualTitle),
        actualContent: cleanActual(body.actualContent),
        postedUrl: cleanActual(body.postedUrl),
        actualUpdatedAt: (body.actualTitle || body.actualContent) ? new Date().toISOString() : '',
        rejectedReason: cleanReason(body.rejectedReason),
        rejectedTags: cleanTags(body.rejectedTags),
        rejectedAt: (body.status === 'rejected') ? new Date().toISOString() : '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      posts.unshift(newPost);
      await postsKV.put('posts', JSON.stringify(posts));

      return new Response(JSON.stringify({ success: true, data: newPost }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // --- PUT /api/posts?id=xxx (update) ---
    if (request.method === 'PUT') {
      const body = await request.json();
      const targetId = postId || body.id;

      if (!targetId) {
        return new Response(JSON.stringify({ success: false, error: 'id required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const index = posts.findIndex(p => p.id === targetId);
      if (index === -1) {
        return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const previousStatus = posts[index].status;
      const updatable = ['title', 'caption', 'platform', 'workspace', 'client', 'pillar', 'date', 'time', 'status', 'approved', 'notes', 'images'];
      for (const key of updatable) {
        if (body[key] !== undefined) {
          posts[index][key] = body[key];
        }
      }
      if (body.rejectedReason !== undefined) posts[index].rejectedReason = cleanReason(body.rejectedReason);
      if (body.rejectedTags !== undefined) posts[index].rejectedTags = cleanTags(body.rejectedTags);
      if (posts[index].status === 'rejected') {
        if (previousStatus !== 'rejected' || !posts[index].rejectedAt) posts[index].rejectedAt = new Date().toISOString();
      } else if (posts[index].rejectedAt) {
        posts[index].rejectedAt = '';
      }
      let actualChanged = false;
      for (const key of ACTUAL_FIELDS) {
        if (body[key] !== undefined) {
          const next = cleanActual(body[key]);
          if (next !== (posts[index][key] || '')) actualChanged = true;
          posts[index][key] = next;
        }
      }
      if (actualChanged && (posts[index].actualTitle || posts[index].actualContent)) {
        posts[index].actualUpdatedAt = new Date().toISOString();
      }
      posts[index].pillar = canonicalPillar(posts[index].pillar);
      posts[index].updatedAt = new Date().toISOString();

      await postsKV.put('posts', JSON.stringify(posts));
      return new Response(JSON.stringify({ success: true, data: {...posts[index], pillar:canonicalPillar(posts[index].pillar)} }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // --- DELETE /api/posts?id=xxx ---
    if (request.method === 'DELETE') {
      const targetId = postId;
      if (!targetId) {
        return new Response(JSON.stringify({ success: false, error: 'id required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const index = posts.findIndex(p => p.id === targetId);
      if (index === -1) {
        return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const deleted = posts.splice(index, 1)[0];
      await postsKV.put('posts', JSON.stringify(posts));
      return new Response(JSON.stringify({ success: true, data: deleted }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
