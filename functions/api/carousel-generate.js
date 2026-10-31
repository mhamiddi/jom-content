import { enforced, json } from '../_lib/auth.js';

/**
 * Generate an on-brand carousel for a calendar post with GPT Image.
 *
 * Two steps so a slow image render never blows one request:
 *   POST ?id=<post>&action=plan            -> text model writes the slide copy
 *   POST ?id=<post>&action=slide&index=0   -> one image per call, stored in R2
 *
 * GET ?id=<post> returns the stored plan and rendered slides. The caption is
 * never rewritten: the carousel is artwork for the existing text.
 */
const IMAGE_MODEL = 'gpt-image-2.5-flare';
const TEXT_MODEL = 'gpt-5.4-mini';
const MIN_SLIDES = 2;
const MAX_SLIDES = 10;
const DEFAULT_SLIDES = 5;
const FALLBACK_PUBLIC_BASE = 'https://pub-c48bb3de52da4fe6bbf5f89e7b07271a.r2.dev';

function publicBase(env) {
  return String(env.MEDIA_PUBLIC_BASE || FALLBACK_PUBLIC_BASE).replace(/\/+$/, '');
}

function stateKey(postId) {
  return 'carousel:' + postId;
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

async function openai(env, path, body) {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    const error = new Error('OPENAI_API_KEY belum dipasang.');
    error.code = 'not_configured';
    throw error;
  }
  const res = await fetch('https://api.openai.com/v1' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && (data.error.message || data.error.code)) || 'HTTP ' + res.status;
    const error = new Error(String(message).slice(0, 300));
    error.code = 'openai_error';
    error.status = res.status;
    throw error;
  }
  return data;
}

function planPrompt(caption, count, title, pillar) {
  return [
    'Buat copy untuk carousel sosial Malaysian creator (Middi, Jom Digital).',
    'Caption asal (JANGAN ubah, cuma ambil idea):',
    '"""' + caption + '"""',
    title ? 'Tajuk post: ' + title : '',
    pillar ? 'Pillar: ' + pillar : '',
    `Hasilkan tepat ${count} slide.`,
    'Peraturan:',
    '- Bahasa Melayu santai profesional, ayat pendek, macam orang bercakap.',
    '- Slide 1 mesti hook kuat. Slide terakhir mesti kesimpulan atau ajakan halus, bukan jualan keras.',
    '- headline: maksimum 5 patah perkataan, HURUF BESAR semua.',
    '- kicker: 1-2 patah perkataan label kecil (contoh: AGENTIC AI, GOOGLE ADS, REALITI).',
    '- sub: satu baris pendek maksimum 10 patah perkataan, boleh kosong.',
    '- Tiada emoji, tiada em dash, tiada tanda petikan, tiada nama brand selain Jom Digital.',
    '- Jangan ulang ayat yang sama antara slide.',
    'Balas JSON sahaja: {"slides":[{"kicker":"...","headline":"...","sub":"..."}]}',
  ].filter(Boolean).join('\n');
}

function slidePrompt(slide, index, total, style) {
  const lines = [
    'Editorial social carousel slide, portrait 2:3, premium Malaysian business creator aesthetic.',
    'Background: matte near-black #0B0B0C with a soft warm gold radial glow near the top and a subtle film grain.',
    'Reserve the top 15 percent and the bottom 15 percent of the frame as empty background: no text or graphics there, so a 4:5 crop keeps every word.',
    'Layout: near the top left, about 18 percent down, a small uppercase gold kicker with a thin gold hairline under it, reading exactly: "' + slide.kicker + '".',
    'Centre: very large bold condensed sans-serif headline in warm cream #F5EFE6, uppercase, at most three lines, reading exactly: "' + slide.headline + '".',
  ];
  if (slide.sub) {
    lines.push('Under the headline: one small light grey sans-serif line reading exactly: "' + slide.sub + '".');
  }
  lines.push('Near the bottom right, about 18 percent from the bottom, a tiny gold slide number "' + String(index + 1).padStart(2, '0') + '/' + String(total).padStart(2, '0') + '".');
  if (style) lines.push('Extra art direction: ' + style);
  lines.push('No logos, no watermark, no emoji, no extra words, no lorem ipsum, high contrast, generous negative space, sharp typography.');
  return lines.join(' ');
}

function normalisePlan(raw, count) {
  const slides = Array.isArray(raw && raw.slides) ? raw.slides : [];
  const cleaned = slides
    .map((slide) => ({
      kicker: clean(slide && slide.kicker, 28).toUpperCase(),
      headline: clean(slide && slide.headline, 60).toUpperCase(),
      sub: clean(slide && slide.sub, 80),
    }))
    .filter((slide) => slide.headline);
  return cleaned.slice(0, count);
}

async function readState(env, postId) {
  const stored = await env.JOM_CONTENT.get(stateKey(postId), { type: 'json' });
  return stored && typeof stored === 'object' ? stored : { postId, slides: [], images: [] };
}

async function writeState(env, postId, state) {
  const payload = { ...state, postId, updatedAt: new Date().toISOString() };
  await env.JOM_CONTENT.put(stateKey(postId), JSON.stringify(payload));
  return payload;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.JOM_CONTENT) return json({ success: false, error: 'KV binding not available' }, 500);
  const url = new URL(request.url);
  const locked = enforced(env);

  if (request.method === 'GET') {
    const postId = String(url.searchParams.get('id') || '').trim();
    const state = postId ? await readState(env, postId) : { slides: [], images: [] };
    return json({
      success: true,
      locked,
      configured: Boolean(env.OPENAI_API_KEY && env.JOM_MEDIA),
      model: IMAGE_MODEL,
      minSlides: MIN_SLIDES,
      maxSlides: MAX_SLIDES,
      defaultSlides: DEFAULT_SLIDES,
      state,
    });
  }
  if (!locked) return json({ success: false, error: 'lock_off', message: 'API lock belum aktif.' }, 403);
  if (request.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch { /* optional body */ }
  const postId = String(url.searchParams.get('id') || body.id || '').trim();
  if (!postId) return json({ success: false, error: 'id required' }, 400);
  const action = String(url.searchParams.get('action') || body.action || '').trim();

  const posts = (await env.JOM_CONTENT.get('posts', { type: 'json' })) || [];
  const post = posts.find((item) => item.id === postId);
  if (!post) return json({ success: false, error: 'not_found', message: 'Post tak dijumpai.' }, 404);

  if (action === 'clear') {
    const cleared = await writeState(env, postId, { slides: [], images: [] });
    return json({ success: true, state: cleared });
  }

  if (action === 'plan') {
    const caption = clean(post.caption, 4000);
    if (!caption) return json({ success: false, error: 'empty_caption', message: 'Caption kosong, tak boleh buat carousel.' }, 422);
    const count = Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, Number(body.count) || DEFAULT_SLIDES));
    try {
      const completion = await openai(env, '/chat/completions', {
        model: TEXT_MODEL,
        messages: [
          { role: 'system', content: 'Kau art director carousel sosial. Balas JSON sahaja, tiada prosa.' },
          { role: 'user', content: planPrompt(caption, count, post.title || '', post.pillar || '') },
        ],
        response_format: { type: 'json_object' },
      });
      const text = completion.choices?.[0]?.message?.content || '{}';
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      const slides = normalisePlan(parsed, count);
      if (slides.length < MIN_SLIDES) {
        return json({ success: false, error: 'plan_failed', message: 'Model tak bagi cukup slide. Cuba lagi.' }, 502);
      }
      const state = await writeState(env, postId, { slides, images: [], count: slides.length });
      return json({ success: true, count: slides.length, slides, state });
    } catch (error) {
      return json({ success: false, error: error.code || 'plan_failed', message: String(error.message || error).slice(0, 300) }, error.status === 401 ? 502 : 502);
    }
  }

  if (action === 'slide') {
    if (!env.JOM_MEDIA) return json({ success: false, error: 'not_configured', message: 'R2 binding JOM_MEDIA belum dipasang.' }, 500);
    const state = await readState(env, postId);
    const slides = Array.isArray(state.slides) ? state.slides : [];
    const index = Number(body.index);
    if (!slides.length) return json({ success: false, error: 'no_plan', message: 'Buat plan carousel dulu.' }, 409);
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) {
      return json({ success: false, error: 'bad_index', message: 'Index slide tak sah.' }, 400);
    }
    const slide = slides[index];
    const style = clean(body.style, 200);
    try {
      const generated = await openai(env, '/images/generations', {
        model: IMAGE_MODEL,
        prompt: slidePrompt(slide, index, slides.length, style),
        size: '1024x1536',
        quality: body.quality === 'medium' ? 'medium' : 'high',
        n: 1,
      });
      const item = generated.data?.[0];
      if (!item || !item.b64_json) {
        return json({ success: false, error: 'image_empty', message: 'OpenAI tak pulangkan imej.' }, 502);
      }
      const bytes = Uint8Array.from(atob(item.b64_json), (char) => char.charCodeAt(0));
      const now = new Date();
      const key = 'media/' + now.getUTCFullYear() + '/' + String(now.getUTCMonth() + 1).padStart(2, '0') +
        '/carousel-' + postId.replace(/[^a-z0-9-]/gi, '').slice(0, 40) + '-' + index + '-' + crypto.randomUUID().slice(0, 8) + '.png';
      await env.JOM_MEDIA.put(key, bytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { postId, slide: String(index), model: IMAGE_MODEL },
      });
      const head = await env.JOM_MEDIA.head(key);
      const imageUrl = publicBase(env) + '/' + key;
      const images = (Array.isArray(state.images) ? state.images : [])
        .filter((image) => image.index !== index)
        .concat([{ index, key, url: imageUrl, size: head?.size || 0, at: now.toISOString() }])
        .sort((a, b) => a.index - b.index);
      const next = await writeState(env, postId, { ...state, images });
      return json({ success: true, index, url: imageUrl, key, size: head?.size || 0, images: next.images });
    } catch (error) {
      return json({ success: false, error: error.code || 'image_failed', message: String(error.message || error).slice(0, 300) }, 502);
    }
  }

  return json({ success: false, error: 'unknown_action', message: 'Action mesti plan, slide atau clear.' }, 400);
}
