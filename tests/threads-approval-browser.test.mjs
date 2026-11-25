import test from 'node:test';
import assert from 'node:assert/strict';
import {toolsRequire,chromePath} from './helpers/tools.mjs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const {chromium}=toolsRequire('playwright-core');
const frozen='https://app.invalid/api/threads-media?asset='+'a'.repeat(64)+'.png';
import {readFileSync} from 'node:fs';
const png=readFileSync(new URL('./fixtures/threads-fixture.png', import.meta.url));
test('owner sees frozen media before approval; cancel and image failure cannot approve',async()=>{
 const browser=await chromium.launch({executablePath:chromePath(),headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:375,height:812}});
 try {
  await page.route('https://app.invalid/api/threads-media?**',r=>r.fulfill({body:png,contentType:'image/png'}));
  await page.setContent('<html><body><h1>Fixture dashboard</h1></body></html>');
  await page.addScriptTag({path:resolve('threads-approval-ui.js')});
  await page.evaluate(url=>{
   window.result='pending';window.calls=0;
   window.start=()=>window.reviewThreadsMedia('p',{caption:'Exact approved caption',accountId:'a',mediaUrl:'https://original.invalid/mutable.png',mediaType:'image'},async()=>{window.calls++;return {success:true,username:'fixture',body:{caption:'Exact approved caption',accountId:'a',mediaUrl:url,mediaType:'image'}};}).then(r=>window.result=r);
   window.start();
  },frozen);
  await page.locator('dialog img').waitFor();
  assert.equal(await page.locator('dialog img').getAttribute('src'),frozen);
  assert.match(await page.locator('dialog').innerText(),/Exact approved caption/);
  await page.locator('[data-threads-approve]:enabled').waitFor();
  assert.equal(await page.evaluate(()=>window.result),'pending');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(tmpdir(),'threads-frozen-review-mobile.png')});
  await page.locator('[data-threads-cancel]').click();
  assert.equal(await page.evaluate(()=>window.result),null);
  await page.evaluate(()=>{window.result='pending';window.start();});
  await page.locator('[data-threads-approve]:enabled').waitFor();
  await page.locator('[data-threads-approve]').click();
  assert.equal((await page.evaluate(()=>window.result)).mediaUrl,frozen);
  await page.unroute('https://app.invalid/api/threads-media?**');
  await page.route('https://app.invalid/api/threads-media?**',r=>r.fulfill({status:409,body:'blocked'}));
  await page.evaluate(()=>{window.result='pending';window.start();});
  await page.getByText('Media gagal dimuatkan. Batal dan sediakan semula.').waitFor();
  assert.equal(await page.locator('[data-threads-approve]').isDisabled(),true);
  await page.locator('[data-threads-cancel]').click();
 } finally {await browser.close();}
});
