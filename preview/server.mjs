#!/usr/bin/env node
/**
 * Local, no-deploy preview for the Threads analysis review UI.
 *
 * It serves the real static page and runs the real Pages Functions
 * (_middleware.js + functions/api/*) in-process against an in-memory KV seeded
 * with preview/analysis-seed.json. No network calls, no Cloudflare account, no
 * production bindings, and no publishing endpoints are wired.
 *
 *   node preview/server.mjs
 *   node preview/server.mjs --port 8790
 *
 * Preview-only credentials (local process env, never committed):
 *   JOM_LOGIN_USER      default jomdigital
 *   JOM_LOGIN_PASSWORD  default preview-only
 *   JOM_API_TOKEN       default preview-api-token
 *   JOM_SESSION_SECRET  default preview-session-secret (must differ from token)
 *
 * Preview-only signing key: an ephemeral Ed25519 keypair is generated on every
 * start unless JOM_APPROVAL_PRIVATE_KEY + JOM_APPROVAL_PUBLIC_KEY are supplied.
 * The public half and its fingerprint are written to preview/out/approvals/ so
 * the host gate can be rehearsed against them. This key is throwaway: it is
 * never the owner's production key and the host only trusts it through the
 * explicit pin argument (see threads_learning_review.gate).
 */
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequest as login } from '../functions/api/login.js';
import { onRequest as logout } from '../functions/api/logout.js';
import { onRequest as session } from '../functions/api/session.js';
import { onRequest as health } from '../functions/api/health.js';
import { onRequest as threadsAnalysis } from '../functions/api/threads-analysis.js';
import { onRequest as learningApprovals } from '../functions/api/learning/approvals.js';
import { RECORDS_KEY, bindingProblem } from '../functions/_lib/analysis-review.js';
import { publicKeyBlock } from '../functions/_lib/approval-envelope.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const requestedPort = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 8788);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 8788;

function previewSigningKey() {
  if (process.env.JOM_APPROVAL_PRIVATE_KEY && process.env.JOM_APPROVAL_PUBLIC_KEY) {
    return {
      privateKey: process.env.JOM_APPROVAL_PRIVATE_KEY,
      publicKey: process.env.JOM_APPROVAL_PUBLIC_KEY,
      keyId: process.env.JOM_APPROVAL_KEY_ID || 'owner-preview-ephemeral',
      generated: false,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  // SPKI for Ed25519 = 12-byte header + 32 raw bytes.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    privateKey: Buffer.from(pkcs8).toString('base64'),
    publicKey: Buffer.from(raw).toString('base64'),
    keyId: process.env.JOM_APPROVAL_KEY_ID || 'owner-preview-ephemeral',
    generated: true,
  };
}

const signing = previewSigningKey();

const env = {
  JOM_API_TOKEN: process.env.JOM_API_TOKEN || 'preview-api-token',
  JOM_SESSION_SECRET: process.env.JOM_SESSION_SECRET || 'preview-session-secret',
  JOM_LOGIN_USER: process.env.JOM_LOGIN_USER || 'jomdigital',
  JOM_LOGIN_PASSWORD: process.env.JOM_LOGIN_PASSWORD || 'preview-only',
  JOM_APPROVAL_PRIVATE_KEY: signing.privateKey,
  JOM_APPROVAL_PUBLIC_KEY: signing.publicKey,
  JOM_APPROVAL_KEY_ID: signing.keyId,
  ANALYSIS_PREVIEW: '1',
  JOM_CONTENT: memoryKv(),
};

function memoryKv() {
  const store = new Map();
  return {
    async get(key, options) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return options?.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    _dump: () => Object.fromEntries(store),
  };
}

const ROUTES = new Map([
  ['/api/login', login],
  ['/api/logout', logout],
  ['/api/session', session],
  ['/api/health', health],
  ['/api/threads-analysis', threadsAnalysis],
  ['/api/learning/approvals', learningApprovals],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const BLOCKED = new Set(['functions', 'tests', 'workers', 'preview', 'docs', '.git', '.wrangler', '.github', 'node_modules']);

async function handleApi(request, env) {
  const { pathname } = new URL(request.url);
  const handler = ROUTES.get(pathname);
  if (!handler) {
    return new Response(JSON.stringify({ success: false, error: 'not_found' }), {
      status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  // Mirror Cloudflare Pages: _middleware wraps every /api route, including login.
  return middleware({ request, env, next: () => handler({ request, env }) });
}

async function handleStatic(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/') return new Response(null, { status: 302, headers: { Location: '/analysis-review.html' } });
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response('Bad request', { status: 400 }); }
  const relative = decoded.replace(/^\/+/, '');
  const top = relative.split('/')[0];
  if (!relative || BLOCKED.has(top) || relative.includes('..') || relative.endsWith('.bak')) {
    return new Response('Not found', { status: 404 });
  }
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep)) return new Response('Not found', { status: 404 });
  const type = MIME[extname(file).toLowerCase()];
  if (!type) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

// The request URL must match how the browser reached this preview, otherwise
// the owner-session Origin check in functions/api/threads-analysis.js rejects
// every write with `cross_origin`. Only loopback hosts are honoured; anything
// else falls back to the bound address so a spoofed Host cannot widen access.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
function requestOrigin(req) {
  const host = String(req.headers.host || '').trim();
  if (LOOPBACK_HOST.test(host)) return `http://${host.toLowerCase()}`;
  return `http://127.0.0.1:${server.address().port}`;
}

const server = createServer(async (req, res) => {
  const origin = requestOrigin(req);
  const body = await readBody(req);
  const request = new Request(origin + req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
  try {
    const response = new URL(request.url).pathname.startsWith('/api/')
      ? await handleApi(request, env)
      : await handleStatic(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (req.method === 'HEAD') return res.end();
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('[preview] request failed:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'preview_server_error' }));
  }
});

const seedPath = resolve(process.env.PREVIEW_SEED || resolve(root, 'preview/analysis-seed.json'));
const seed = JSON.parse(await readFile(seedPath, 'utf8'));
await env.JOM_CONTENT.put(RECORDS_KEY, JSON.stringify(seed));

// Be explicit about the one thing a demo seed cannot do: reach the host gate.
// A record without a complete binding (or with a demo digest) can be reviewed
// and downloaded, but the host gate will never emit it as a lesson.
const bindingCounts = seed.reduce((acc, record) => {
  const problem = bindingProblem(record?.binding);
  const key = problem || 'bound';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

// Publish the throwaway preview public key so the host gate can be rehearsed.
let keyInfo = null;
try {
  const block = await publicKeyBlock(signing.publicKey, signing.keyId, new Date().toISOString());
  const outDir = resolve(root, 'preview/out/approvals');
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'owner-public-key.json'), JSON.stringify(block, null, 2) + '\n');
  await writeFile(resolve(outDir, 'pinned.json'), JSON.stringify({
    key_id: block.key_id, fingerprint_sha256: block.fingerprint_sha256, note: 'ephemeral preview key; not the owner key',
  }, null, 2) + '\n');
  keyInfo = { fingerprint: block.fingerprint_sha256, dir: outDir };
} catch (error) {
  console.error('[preview] could not publish preview key material:', error.message);
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`[preview] port ${port} is in use; pass --port 0 to pick a free port.`);
  else console.error('[preview] server error:', error);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`[preview] analysis review UI  http://localhost:${actual}/analysis-review.html`);
  console.log(`[preview] same preview via   http://127.0.0.1:${actual}/analysis-review.html`);
  console.log(`[preview] seeded ${seed.length} analysis records (in-memory, resets on exit)`);
  console.log('[preview] seed bindings: ' + Object.entries(bindingCounts)
    .map(([key, count]) => `${key}=${count}`).join(' '));
  if (bindingCounts.bound !== seed.length) {
    console.log('[preview] note: unbound records are reviewable demo data only; the host gate refuses them.');
  }
  console.log(`[preview] login ${env.JOM_LOGIN_USER} / ${env.JOM_LOGIN_PASSWORD}  (preview-only)`);
  if (keyInfo) {
    console.log(`[preview] approval key ${signing.keyId} ${signing.generated ? '(ephemeral)' : '(from env)'}`);
    console.log(`[preview] key fingerprint ${keyInfo.fingerprint}`);
    console.log(`[preview] key files ${keyInfo.dir}`);
  }
});
