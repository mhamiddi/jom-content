// One Durable Object instance per JSON.stringify([accountId, postId]).
// The binding is internal: the default Worker intentionally exposes no routes.
const reply = (body, status = 200) => Response.json(body, { status });
const conflict = (error, record) => reply({ success: false, error, ...(record ? { state: record.state, ids: record.ids || [], urls: record.urls || [] } : {}) }, 409);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const barrier = record => !record ? null : record.state === 'published' ? 'already_posted' : record.state === 'uncertain' ? 'reconciliation_required' : record.state === 'in_progress' ? 'in_progress' : null;

export class ThreadsPublishGuard {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS guard (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/approve', '/claim', '/status', '/finish'].includes(path)) return reply({ success: false, error: 'not_found' }, 404);
    let body;
    try { body = await request.json(); } catch { return reply({ success: false, error: 'invalid_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ success: false, error: 'invalid_request' }, 400);
    if (path === '/approve' && (!nonempty(body.digest) || !body.manifest || typeof body.manifest !== 'object' || Array.isArray(body.manifest) || !nonempty(body.approvedAt))) return reply({ success: false, error: 'invalid_request' }, 400);
    if (path === '/claim' && (!nonempty(body.digest) || !nonempty(body.attemptId))) return reply({ success: false, error: 'invalid_request' }, 400);
    if (path === '/finish' && (!nonempty(body.attemptId) || !['published', 'uncertain', 'failed'].includes(body.state) || !Array.isArray(body.ids) || !Array.isArray(body.urls) || !body.ids.every(x => typeof x === 'string') || !body.urls.every(x => typeof x === 'string'))) return reply({ success: false, error: 'invalid_request' }, 400);

    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec('SELECT record FROM guard WHERE id = 1').toArray()[0];
      const record = row ? JSON.parse(row.record) : null;
      const save = value => this.storage.sql.exec('INSERT INTO guard (id, record) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record', JSON.stringify(value));
      if (path === '/status') return reply({ success: true, ...(record || { state: 'empty' }) });
      if (path === '/finish') {
        if (!record || record.state !== 'in_progress' || record.attemptId !== body.attemptId) return conflict(barrier(record) || 'approval_required', record);
        const finished = { ...record, state: body.state === 'published' ? 'published' : 'uncertain', ids: body.ids, urls: body.urls };
        save(finished);
        return reply({ success: true, ...finished });
      }
      const blocked = barrier(record);
      if (blocked) return conflict(blocked, record);
      if (path === '/approve') {
        const approved = { state: 'ready', digest: body.digest, manifest: body.manifest, approvedAt: body.approvedAt };
        save(approved);
        return reply({ success: true, ...approved });
      }
      if (!record || record.state !== 'ready' || record.digest !== body.digest) return conflict('approval_required');
      const claimed = { ...record, state: 'in_progress', attemptId: body.attemptId };
      save(claimed);
      return reply({ success: true, ...claimed });
    });
  }
}

export default { fetch() { return new Response('Not Found', { status: 404 }); } };
