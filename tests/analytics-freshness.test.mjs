import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../analytics.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function renderKpis(d)'), html.indexOf('function renderContentBankHealth'));
test('follower card exposes the observed date and collection source',()=>{
  const target={innerHTML:''};
  const c={fmt:x=>String(x),trend:()=>'',scoreColor:()=>'',esc:x=>String(x),plat:'threads',card:(label,value,sub)=>[label,value,sub].join(' '),$:()=>target};
  vm.createContext(c);vm.runInContext(source,c);
  c.renderKpis({month:{items:1,views:10,likes:1,comments:1,shares:1},week:{items:1},followers:{latest:6141,as_of:'2026-11-11',source:'threads_api'}});
  assert.match(target.innerHTML,/2026-11-11/);
  assert.match(target.innerHTML,/Threads API/);
});
