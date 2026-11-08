// Durable guard is mandatory. Never fall back to eventually-consistent KV.
export async function guardCall(env, userId, postId, action, payload={}) {
 if(!env.THREADS_GUARD) return {status:503,data:{success:false,error:'publish_guard_unavailable'}};
 try {
  const id=env.THREADS_GUARD.idFromName(JSON.stringify([String(userId),String(postId)]));
  const response=await env.THREADS_GUARD.get(id).fetch('https://internal/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json();
  return {status:response.status,data};
 } catch { return {status:503,data:{success:false,error:'publish_guard_unavailable'}}; }
}
