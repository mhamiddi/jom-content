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
      const status = url.searchParams.get('status');
      const pillar = url.searchParams.get('pillar');
      const month = url.searchParams.get('month'); // YYYY-MM

      let filtered = [...posts];
      if (platform) filtered = filtered.filter(p => p.platform === platform);
      if (status) filtered = filtered.filter(p => p.status === status);
      if (pillar) filtered = filtered.filter(p => p.pillar === pillar);
      if (month) filtered = filtered.filter(p => p.date && p.date.startsWith(month));

      return new Response(JSON.stringify({ success: true, data: filtered }), {
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

      const validPlatforms = ['tiktok', 'facebook', 'instagram', 'threads'];
      if (!validPlatforms.includes(body.platform)) {
        return new Response(JSON.stringify({ success: false, error: 'invalid platform' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const newPost = {
        id: crypto.randomUUID(),
        title: body.title,
        platform: body.platform,
        caption: body.caption || '',
        pillar: body.pillar || 'General',
        date: body.date || '',
        time: body.time || '',
        status: body.status || 'draft',
        approved: body.approved || false,
        notes: body.notes || '',
        images: body.images || [],
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

      const updatable = ['title', 'caption', 'platform', 'pillar', 'date', 'time', 'status', 'approved', 'notes', 'images'];
      for (const key of updatable) {
        if (body[key] !== undefined) {
          posts[index][key] = body[key];
        }
      }
      posts[index].updatedAt = new Date().toISOString();

      await postsKV.put('posts', JSON.stringify(posts));
      return new Response(JSON.stringify({ success: true, data: posts[index] }), {
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
