/**
 * Jom Content API — Single Post CRUD
 * CF Pages Function
 * 
 * PUT /api/posts/:id — update post
 * DELETE /api/posts/:id — delete post
 * 
 * KV namespace: JOM_CONTENT
 */

export async function onRequest(context) {
  const { request, env, params } = context;
  const postId = params.id;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const postsKV = env.JOM_CONTENT;

  try {
    let posts = [];
    const raw = await postsKV.get('posts', { type: 'json' });
    if (raw && Array.isArray(raw)) posts = raw;

    const index = posts.findIndex(p => p.id === postId);
    if (index === -1) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      // Only update provided fields
      const updatable = ['title', 'caption', 'platform', 'pillar', 'date', 'time', 'status', 'approved', 'notes'];
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

    if (request.method === 'DELETE') {
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
