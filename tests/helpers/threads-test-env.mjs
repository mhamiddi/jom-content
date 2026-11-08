import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ThreadsPublishGuard } from '../../workers/threads-publish-guard/index.js';

const types = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4' };
export const fixture = (name, ext = 'jpg', origin = 'https://app.invalid') => {
  const bytes = Buffer.from(`frozen fixture: ${name}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const asset = `${digest}.${ext}`;
  return { bytes, asset, url: `${origin}/api/threads-media?asset=${asset}`, type: types[ext] };
};

export function testBindings(fixtures) {
  const objects = new Map(fixtures.map(f => [`threads-approved/${f.asset}`, f]));
  const JOM_MEDIA = {
    async head(key) {
      const f = objects.get(key);
      if (!f) return null;
      const checksum = createHash('sha256').update(f.bytes).digest();
      return { checksums: { sha256: checksum }, httpMetadata: { contentType: f.type }, size: f.bytes.length, etag: checksum.toString('hex') };
    },
    async get(key) {
      const metadata = await this.head(key);
      if (!metadata) return null;
      return { ...metadata, body: new Blob([objects.get(key).bytes]).stream() };
    },
  };
  const instances = new Map();
  const THREADS_GUARD = {
    idFromName(name) { return name; },
    get(id) {
      if (!instances.has(id)) {
        const db = new DatabaseSync(':memory:');
        const storage = {
          sql: { exec(query, ...args) {
            if (query.startsWith('CREATE')) { db.exec(query); return { toArray: () => [] }; }
            const stmt = db.prepare(query);
            if (query.startsWith('SELECT')) return { toArray: () => stmt.all(...args) };
            stmt.run(...args); return { toArray: () => [] };
          } },
          transactionSync(fn) {
            db.exec('BEGIN');
            try { const result = fn(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
          },
        };
        const guard = new ThreadsPublishGuard({ storage }, {});
        instances.set(id, { fetch: (url, init) => guard.fetch(new Request(url, init)) });
      }
      return instances.get(id);
    },
  };
  return { JOM_MEDIA, THREADS_GUARD, objects };
}
