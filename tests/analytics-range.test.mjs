import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRange,selectAnalytics,mytToday} from '../analytics-range.mjs';
const p=(date,views,score=50)=>({date,views,score,likes:2,comments:1,shares:3,reposts:4,quotes:5,format:'text'});
const data={window:{from:'2026-10-30',to:'2026-11-28'},history_from:'2026-09-07',history_posts:[p('2026-11-28',50),p('2026-11-27',100),p('2026-11-22',200),p('2026-11-15',300),p('2026-11-01',400),p('2026-10-25',500)],history_replies:[p('2026-11-27',30)],coverage:{}};
test('MYT day cutoff and all inclusive calendar presets',()=>{
 assert.equal(mytToday(Date.parse('2026-11-27T16:01:00Z')),'2026-11-28');
 for(const [preset,from,to,total] of [['today','2026-11-28','2026-11-28',50],['yesterday','2026-11-27','2026-11-27',100],['7','2026-11-22','2026-11-28',350],['14','2026-11-15','2026-11-28',650],['30','2026-10-30','2026-11-28',1050]]){
  const r=resolveRange(preset,null,null,'2026-11-28');assert.equal(r.from,from);assert.equal(r.to,to);const s=selectAnalytics(data,r,'threads');assert.equal(s.month.views,total);assert.equal(s.daily.length,r.days);assert.equal(s.month.interactions,s.month.items*15);
 }
});
test('custom range uses private extended history and filters posts, ranking, daily, replies',()=>{
 const r=resolveRange('custom','2026-10-25','2026-11-01','2026-11-28');const s=selectAnalytics(data,r,'threads');assert.equal(s.month.views,900);assert.equal(s.posts.length,2);assert.equal(s.top_selected_views[0].views,500);assert.equal(s.daily.length,8);assert.equal(s.replies_30d.items,0);assert.equal(s.rangeComplete,true);
});
test('invalid dates reject and incomplete coverage is explicit',()=>{
 assert.throws(()=>resolveRange('custom','2026-11-29','2026-11-28','2026-11-28'));const s=selectAnalytics(data,resolveRange('custom','2026-08-01','2026-09-01','2026-11-28'),'threads');assert.equal(s.rangeComplete,false);assert.equal(s.daily.length,0);assert.equal(s.month.trend_views_pct,null);
});
