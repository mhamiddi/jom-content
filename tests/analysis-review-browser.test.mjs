import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { toolsRequire, chromePath } from './helpers/tools.mjs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSession } from '../functions/_lib/auth.js';

const { chromium } = toolsRequire('playwright-core');

const CHROME = chromePath();

function startPreview() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['preview/server.mjs', '--port', '0'], {
      cwd: resolve('.'), env: { ...process.env, JOM_LOGIN_PASSWORD: 'preview-only' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('preview server did not start: ' + out)), 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/analysis review UI\s+(http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timer); resolvePromise({ child, base: match[1] }); }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('preview server exited ' + code + ': ' + out)); });
  });
}

test('owner reviews analysis, approves the exact hash, and an edit invalidates it (375px)', async (t) => {
  const { child: server, base } = await startPreview();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.kill('SIGTERM'); });

  const session = await makeSession({ JOM_API_TOKEN: 'preview-api-token', JOM_SESSION_SECRET: 'preview-session-secret' });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addCookies([{ name: 'jc_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();

  const writeCalls = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/publish|media-prepare|\/api\/posts/.test(path)) writeCalls.push(request.method() + ' ' + path);
  });

  await page.goto(base + '/analysis-review.html');
  await page.locator('.review').first().waitFor();
  assert.equal(await page.locator('.review').count(), 3);
  assert.equal(await page.locator('#previewBanner.show').count(), 1);

  const card = page.locator('.review').first();
  for (const selector of ['.post', '.ref', '.metrics', '.evidence', '.observation', '.hypo', '.suggestion', '.hashline code']) {
    assert.equal(await card.locator(selector).count(), 1, selector);
  }
  const hash = (await card.locator('.hashline code').textContent()).trim();
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.match(await card.locator('.hypo').innerText(), /belum terbukti/i);
  assert.match(await card.locator('.hypo').innerText(), /hipotesis/i);
  assert.match(await card.locator('.observation').innerText(), /pemerhatian/i);

  // The N0 binding is visible, and a record without one says so plainly.
  assert.equal(await card.locator('.binding[data-binding="ok"]').count(), 1);
  assert.match(await card.locator('.binding').innerText(), /tl-/i);
  assert.equal(await page.locator('.review .binding[data-binding="missing"]').count(), 1,
    'exactly one demo record has no N0 binding');
  assert.match(await page.locator('.review .binding[data-binding="missing"]').innerText(), /Tiada binding N0/i);

  // No decision exists yet.
  assert.equal(await card.locator('.chip.status-pending').count(), 1);
  assert.match(await card.locator('.decision-meta').innerText(), /Belum ada keputusan/);

  // Approve must pass through the explicit confirm dialog showing the exact hash.
  await card.locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  assert.equal((await page.locator('#confirmHash').textContent()).trim(), hash);
  assert.equal((await page.locator('#confirmPost').textContent()).trim(), (await card.locator('.post').innerText()).trim());
  await page.locator('#confirmDialog button[value="cancel"]').click();
  await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
  assert.equal(await card.locator('.chip.status-approved').count(), 0);

  await card.locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  await page.locator('#confirmDialog button[value="confirm"]').click();
  await page.locator('.review').first().locator('.chip.status-approved').waitFor();
  assert.match(await page.locator('.review').first().locator('.decision-meta').innerText(), /Keputusan terakhir/);
  assert.equal(await page.locator('.review').first().locator('.hashline code').textContent(), hash);

  // Editing the generated post must change the hash and invalidate the approval.
  const edited = page.locator('.review').first();
  await edited.locator('details.edit summary').click();
  await edited.locator('[data-edit]').fill('Post dijana yang diedit oleh pemilik untuk ujian.');
  await edited.locator('[data-act="save-edit"]').click();
  await edited.locator('.stale.show').waitFor();
  assert.match(await edited.locator('.rev-head').innerText(), /kandungan berubah/i);
  assert.equal(await edited.locator('.chip.status-approved').count(), 0);
  assert.notEqual((await edited.locator('.hashline code').textContent()).trim(), hash);
  assert.match(await edited.locator('.decision-meta').innerText(), /dibatalkan oleh edit/i);

  // Re-approving the edited text stores a new decision bound to the new hash.
  const newHash = (await edited.locator('.hashline code').textContent()).trim();
  await edited.locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  assert.equal((await page.locator('#confirmHash').textContent()).trim(), newHash);
  await page.locator('#confirmDialog button[value="confirm"]').click();
  await page.locator('.review').first().locator('.chip.status-approved').waitFor();

  // The owner can mirror the signed envelope the host gate consumes.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#envelopeBtn').click(),
  ]);
  assert.equal(download.suggestedFilename(), 'envelope.json');
  const saved = join(tmpdir(), download.suggestedFilename());
  await download.saveAs(saved);
  const envelope = JSON.parse(await readFile(saved, 'utf8'));
  assert.equal(envelope.schema, 'threads-learning-approval-envelope/v1');
  assert.equal(envelope.approvals.length, 1, 'only the approved, bound record is emitted');
  assert.match(envelope.approvals[0].analysis_sha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.approvals[0].candidate_id, 'tl-dailycal-7aa25be93a23defb185a8d98-72h');
  assert.equal(envelope.approvals[0].review_sha256, newHash);
  assert.equal(typeof envelope.signature_b64, 'string');
  await page.locator('#toast.show').waitFor();
  assert.match(await page.locator('#toast').innerText(), /1 kelulusan/);

  // Layout: no horizontal overflow at 375px, dialog fits inside the viewport.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('.review').first().locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  const box = await page.locator('#confirmDialog').boundingBox();
  assert.ok(box.width <= 375, 'dialog must fit a 375px viewport');
  await page.locator('#confirmDialog button[value="cancel"]').click();
  await page.screenshot({ path: join(tmpdir(), 'analysis-review-mobile.png'), fullPage: true });

  assert.deepEqual(writeCalls, [], 'review UI must not call any publishing endpoint');
  assert.deepEqual(pageErrors, [], 'the page must load and interact without uncaught errors');

  // A session-less browser sees the login gate instead of analysis content.
  const anonymous = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(base + '/analysis-review.html');
  await anonymousPage.locator('#gate:not([hidden])').waitFor();
  assert.equal(await anonymousPage.locator('#app').isHidden(), true);
  await anonymous.close();
});

function contrastOf(selector) {
  const el = document.querySelector(selector);
  const cs = getComputedStyle(el);
  const parse = (value) => value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const x = channel / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(parse(cs.color));
  const b = lum(parse(cs.backgroundColor));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

test('preview UX: centered dialog, loopback-origin writes, friendly errors, preserved drafts, tap targets', async (t) => {
  const { child: server, base } = await startPreview();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.kill('SIGTERM'); });

  // The preview is reachable as localhost and 127.0.0.1; the owner Origin check
  // must pass on whichever host the browser actually used.
  const alias = base.replace('//localhost:', '//127.0.0.1:');
  const session = await makeSession({ JOM_API_TOKEN: 'preview-api-token', JOM_SESSION_SECRET: 'preview-session-secret' });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addCookies([{ name: 'jc_session', value: session, url: alias, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(alias + '/analysis-review.html');
  await page.locator('.review').first().waitFor();

  // The confirmation dialog is centered in the viewport, not pinned to the corner.
  await page.locator('.review').first().locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  const mobile = await page.locator('#confirmDialog').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(mobile.x >= 8 && mobile.y >= 8, 'dialog must not touch the viewport edges: ' + JSON.stringify(mobile));
  assert.ok(Math.abs(mobile.x + mobile.width / 2 - viewport.width / 2) <= 2, 'dialog is horizontally centered');
  assert.ok(Math.abs(mobile.y + mobile.height / 2 - viewport.height / 2) <= 2, 'dialog is vertically centered');
  assert.ok(mobile.width <= viewport.width, 'dialog fits the 375px viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  // Approve is readable (>= 4.5:1) and every control clears the 44px touch target.
  const approveContrast = await page.evaluate(contrastOf, '[data-act="approve"]');
  assert.ok(approveContrast >= 4.5, 'approve button contrast ' + approveContrast.toFixed(2));
  const undersized = await page.evaluate(() => [...document.querySelectorAll('button, .h-actions a, .edit summary')]
    .filter((el) => { const rect = el.getBoundingClientRect(); return rect.height > 0 && rect.height < 44; })
    .map((el) => el.textContent.trim().slice(0, 20) + '=' + Math.round(el.getBoundingClientRect().height)));
  assert.deepEqual(undersized, [], 'every interactive control must be at least 44px tall');
  await page.locator('#confirmDialog button[value="cancel"]').click();
  await page.locator('#confirmDialog').waitFor({ state: 'hidden' });

  // Approving over 127.0.0.1 works: the server derives its own origin from Host.
  const first = page.locator('.review[data-id="ana-2026-11-13-03"]');
  await first.locator('[data-act="approve"]').click();
  await page.locator('#confirmDialog[open]').waitFor();
  await page.locator('#confirmDialog button[value="confirm"]').click();
  await first.locator('.chip.status-approved').waitFor();
  assert.doesNotMatch(await page.locator('#toast').innerText(), /cross_origin/);

  // Unsaved notes/edits on other cards survive a decision that re-renders the list.
  const second = page.locator('.review[data-id="ana-2026-11-13-02"]');
  const third = page.locator('.review[data-id="ana-2026-11-13-01"]');
  await first.locator('[data-note]').fill('NOTA KAD SATU belum dihantar');
  await third.locator('details.edit summary').click();
  await third.locator('[data-edit]').fill('DRAF EDIT KAD TIGA belum disimpan');
  await second.locator('[data-note]').fill('Nota revisi untuk kad dua');
  await second.locator('[data-act="revise"]').click();
  await second.locator('.chip.status-revise').waitFor();
  assert.equal(await first.locator('[data-note]').inputValue(), 'NOTA KAD SATU belum dihantar');
  assert.equal(await third.locator('[data-edit]').inputValue(), 'DRAF EDIT KAD TIGA belum disimpan');
  assert.equal(await third.locator('details.edit').evaluate((el) => el.open), true, 'open editor stays open');

  // A server rejection is shown as a sentence, never the raw error code, and the
  // owner's note is still there to retry with.
  await page.route('**/api/threads-analysis?id=*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'cross_origin' }) });
  });
  const rejected = page.locator('.review[data-id="ana-2026-11-13-01"]');
  await rejected.locator('[data-note]').fill('nota yang perlu kekal');
  // Drop the previous success toast so the next assertion cannot read it back.
  await page.locator('#toast').evaluate((el) => { el.classList.remove('show'); el.textContent = ''; });
  await rejected.locator('[data-act="revise"]').click();
  await page.waitForFunction(() => /asal halaman tidak sepadan/i.test(document.querySelector('#toast').textContent));
  const message = (await page.locator('#toast').innerText()).trim();
  assert.doesNotMatch(message, /^[a-z_]+$/i, 'raw server code leaked to the owner: ' + message);
  assert.match(message, /asal halaman tidak sepadan/i);
  assert.equal(await rejected.locator('[data-note]').inputValue(), 'nota yang perlu kekal');
  await page.unroute('**/api/threads-analysis?id=*');

  assert.deepEqual(pageErrors, []);
  await context.close();
});
