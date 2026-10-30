import { enforced, json } from '../_lib/auth.js';

/**
 * Upload a video or image to the jom-content-media R2 bucket.
 *
 * The body is the raw file (not multipart) so large uploads stream straight into
 * R2 without buffering twice. Query params:
 *   filename  original file name, used for the extension and metadata
 *   type      mime type, defaults to application/octet-stream
 */
const MAX_BYTES = 90 * 1024 * 1024;
const FALLBACK_PUBLIC_BASE = 'https://pub-c48bb3de52da4fe6bbf5f89e7b07271a.r2.dev';
const ALLOWED = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function publicBase(env) {
  return String(env.MEDIA_PUBLIC_BASE || FALLBACK_PUBLIC_BASE).replace(/\/+$/, '');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!enforced(env)) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif.' }, 403);
  if (!env.JOM_MEDIA) return json({ success: false, error: 'not_configured', message: 'R2 binding JOM_MEDIA belum dipasang.' }, 500);

  if (request.method === 'GET') {
    return json({ success: true, configured: true, publicBase: publicBase(env), maxBytes: MAX_BYTES, types: Object.keys(ALLOWED) });
  }
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);

  const type = String(url.searchParams.get('type') || request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED[type];
  if (!ext) {
    return json({ success: false, error: 'unsupported_type', message: 'Format tak disokong. Guna mp4, mov, webm, jpg, png atau webp.' }, 415);
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) {
    return json({ success: false, error: 'too_large', message: 'Fail melebihi ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB.' }, 413);
  }
  if (!request.body) return json({ success: false, error: 'empty_body' }, 400);

  const now = new Date();
  const key = 'media/' + now.getUTCFullYear() + '/' + String(now.getUTCMonth() + 1).padStart(2, '0') + '/' +
    crypto.randomUUID() + '.' + ext;
  const original = String(url.searchParams.get('filename') || '').slice(0, 200);

  let stored;
  try {
    stored = await env.JOM_MEDIA.put(key, request.body, {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { originalName: original, uploadedAt: now.toISOString() },
    });
  } catch (error) {
    return json({ success: false, error: 'upload_failed', message: String(error.message || error).slice(0, 300) }, 502);
  }

  // Read the object back so the response reports stored state, not intent.
  const head = await env.JOM_MEDIA.head(key);
  return json({
    success: true,
    key,
    url: publicBase(env) + '/' + key,
    size: head?.size ?? stored?.size ?? 0,
    type,
  });
}
