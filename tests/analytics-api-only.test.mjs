import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../analytics.html',import.meta.url),'utf8');
function context(){const out={innerHTML:''};const c={fmt:x=>String(x),trend:()=>'',scoreColor:()=>'',esc:x=>String(x),plat:'threads',card:(...args)=>args.join(' '),$:()=>out};vm.createContext(c);return [c,out];}
test('Threads interactions card uses all five official engagement metrics',()=>{
 const [c,out]=context();vm.runInContext(html.slice(html.indexOf('function renderKpis(d)'),html.indexOf('function renderContentBankHealth')),c);
 c.renderKpis({month:{items:1,views:100,likes:10,comments:2,shares:3,reposts:4,quotes:5,interactions:24},week:{items:1}});
 assert.match(out.innerHTML,/Interactions 24 /);assert.match(out.innerHTML,/4 repost/);assert.match(out.innerHTML,/5 quote/);
});
test('single API follower observation uses an explicit empty state, not a blank chart',()=>{
 const nodes={growthChart:{innerHTML:'',style:{}},growthBadge:{textContent:''},growthNote:{textContent:''}};
 const c={$:id=>nodes[id],fmt:String};vm.createContext(c);vm.runInContext(html.slice(html.indexOf('function renderGrowth(d)'),html.indexOf('function metaLine(p)')),c);
 c.renderGrowth({followers:{latest:6158,as_of:'2026-11-11',history:[{date:'2026-11-11',value:6158}]}});
 assert.equal(nodes.growthChart.style.display,'none');assert.match(nodes.growthNote.textContent,/selepas beberapa hari/);
});

test('missing API insights are disclosed rather than silently shown as complete totals',()=>{
 const box={textContent:'',classList:{toggle(){}}};const c={plat:'threads',PLATFORM:{threads:{name:'Threads'}},$:()=>box,Date,Math};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('function renderNotice(d)'),html.indexOf('function card(')),c);
 c.renderNotice({last_collected:new Date().toISOString(),month:{partial_insights:3,missing_insights:2},coverage:{comparison_complete:false},metric_source:'threads_api'});
 assert.match(box.textContent,/3 post/);assert.match(box.textContent,/tidak lengkap/);
});
