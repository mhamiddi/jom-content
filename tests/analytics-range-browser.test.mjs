import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {toolsRequire,chromePath} from './helpers/tools.mjs';
import {mytToday,resolveRange} from '../analytics-range.mjs';
const {chromium}=toolsRequire('playwright-core');
const root=resolve('.'),theme=resolve('../jd-shell');
const today=mytToday(),yesterday=resolveRange('yesterday').from;
const row=(id,date,views)=>({id,date,views,url:'https://example.test/post/'+id,text:'Synthetic post',likes:2,comments:1,shares:1,reposts:1,quotes:0,saves:0,score:50,format:'text'});
function platform(handle,posts){return {handle,metric_source:'threads_api',last_collected:new Date().toISOString(),window:resolveRange('30'),history_from:resolveRange('30').from,history_posts:posts,history_replies:[],posts,month:{},coverage:{comparison_complete:true},followers:null};}
const data={generated_at:new Date().toISOString(),platforms:{threads:platform('fixture',[row('1',today,250),row('2',yesterday,100)]),tiktok:platform('fixture2',[row('3',today,50)])}};
const assets={'/hub/content-analytics/analytics-range.mjs':join(root,'analytics-range.mjs'),'/hub/content-analytics/analytics-weekday.mjs':join(root,'analytics-weekday.mjs'),'/_jd/theme.css':join(theme,'theme.css'),'/_jd/apps/jom-content.css':join(theme,'apps/jom-content.css'),'/_jd/apps/jom-content.js':join(theme,'apps/jom-content.js'),'/_jd/shell.js':join(theme,'shell.js')};
for(const w of [400,500,600,700])assets[`/_jd/fonts/poppins-${w}.woff2`]=join(theme,`fonts/poppins-${w}.woff2`);
test('mobile analytics under OS shell: period presets, custom and platform switch update views',{skip:!existsSync(join(theme,'theme.css'))},async t=>{
 const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/hub/content-analytics/'){const html=readFileSync(join(root,'analytics.html'),'utf8').replace('</head>','<link rel="stylesheet" href="/_jd/theme.css" data-jd-shell><link rel="stylesheet" href="/_jd/apps/jom-content.css"><script defer src="/_jd/apps/jom-content.js"></script><script defer src="/_jd/shell.js" data-jd-app="content-analytics"></script></head>');res.setHeader('Content-Type','text/html');return res.end(html);}
  if(path.endsWith('/analytics-data.json')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(data));}
  if(assets[path]){res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':'text/javascript');return res.end(readFileSync(assets[path]));}
  res.writeHead(404).end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:chromePath(),headless:true,args:['--no-sandbox']});t.after(async()=>{await browser.close();server.close();});
 const page=await browser.newPage({viewport:{width:375,height:812}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://os.jomdigitalos.my/_jd/fonts/**',r=>r.fulfill({status:200,contentType:'font/woff2',body:readFileSync(join(theme,'fonts',new URL(r.request().url()).pathname.split('/').pop()))}));
 await page.goto(`http://127.0.0.1:${server.address().port}/hub/content-analytics/`);await page.locator('.jd-app-content-analytics #kpis .card').first().waitFor();
 const views=()=>page.locator('#kpis .card .value').first().textContent();assert.equal(await views(),'350');
 await page.getByRole('button',{name:'Today',exact:true}).click();assert.equal(await views(),'250');
 await page.getByRole('button',{name:'Yesterday',exact:true}).click();assert.equal(await views(),'100');
 await page.getByRole('button',{name:'Past 7 days',exact:true}).click();assert.equal(await views(),'350');
 await page.getByRole('button',{name:'Past 14 days',exact:true}).click();assert.equal(await views(),'350');
 await page.getByRole('button',{name:'Past 30 days',exact:true}).click();assert.equal(await views(),'350');
 await page.getByRole('button',{name:'Custom',exact:true}).click();await page.locator('#rangeFrom').fill(yesterday);await page.locator('#rangeTo').fill(yesterday);await page.getByRole('button',{name:'Apply'}).click();assert.equal(await views(),'100');
 await page.locator('#platformControls button[data-p=tiktok]').click();assert.equal(await views(),'0');
 await page.getByRole('button',{name:'Today',exact:true}).click();assert.equal(await views(),'50');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 assert.equal(await page.locator('.jd-drawer-foot a').getAttribute('href'),'/owner/logout');
});
