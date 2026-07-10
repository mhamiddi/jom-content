/**
 * Jom Content API — Posts
 * CF Pages Function
 * 
 * GET /api/posts — list all posts
 * POST /api/posts — create new post
 * 
 * KV namespace: JOM_CONTENT
 * Key: "posts" — JSON array of all posts
 */

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const postsKV = env.JOM_CONTENT;

  try {
    // Read existing posts
    let posts = [];
    const raw = await postsKV.get('posts', { type: 'json' });
    if (raw && Array.isArray(raw)) posts = raw;

    if (request.method === 'GET') {
      // Parse query params
      const url = new URL(request.url);
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

    if (request.method === 'POST') {
      const body = await request.json();

      // Validate required fields
      if (!body.title || !body.platform) {
        return new Response(JSON.stringify({ success: false, error: 'title and platform required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Validate platform
      const validPlatforms = ['tiktok', 'facebook', 'instagram', 'threads'];
      if (!validPlatforms.includes(body.platform)) {
        return new Response(JSON.stringify({ success: false, error: 'invalid platform' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Create new post
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
