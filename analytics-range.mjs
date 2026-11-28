// Publication cohorts: latest observed metrics of posts published inside the selected MYT dates.
// This is not account-wide activity during those dates. No missing observation becomes a fake zero.
export const PRESETS = {today:'Today', yesterday:'Yesterday', '7':'Past 7 days', '14':'Past 14 days', '30':'Past 30 days', custom:'Custom'};
const DAY = 86400000;
const metrics = ['views','likes','comments','shares','saves','reposts','quotes'];
const engagement = ['likes','comments','shares','reposts','quotes'];
const date = t => new Date(t).toISOString().slice(0,10);
export const mytToday = (now = Date.now()) => date(Number(now) + 8*3600000);
const stamp = s => Date.parse(s+'T00:00:00Z');
const validDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(stamp(s)) && date(stamp(s))===s;
const add = (s,n) => date(stamp(s)+n*DAY);
const num = x => x == null ? 0 : Number(x)||0;
const sum = (rows,k) => rows.reduce((n,p)=>n+num(p[k]),0);
const interaction = p => engagement.reduce((n,k)=>n+num(p[k]),0);
const avg = rows => {const scores=rows.filter(p=>p.score!=null).map(p=>Number(p.score));return scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length*10)/10:null;};
const pct = (x,y) => x!=null&&y>0?Math.round(100*(x-y)/y):null;
export function resolveRange(preset, from, to, today=mytToday()) {
  if (!Object.hasOwn(PRESETS,preset)) preset='30';
  if (preset==='custom') {
    if (!validDate(from)||!validDate(to)||from>to||to>today) throw new Error('Pilih tarikh mula dan akhir yang sah (MYT).');
  } else {to=preset==='yesterday'?add(today,-1):today;from=add(to, -(Number(preset)||1)+1);}
  return {preset,from,to,days:Math.round((stamp(to)-stamp(from))/DAY)+1,label:PRESETS[preset]};
}
function summarize(rows, plat){
 const available=metrics.filter(k=>plat==='threads'?k!=='saves':!['reposts','quotes'].includes(k));
 const total=Object.fromEntries(metrics.map(k=>[k,sum(rows,k)]));
 return {...total,items:rows.length,interactions:rows.reduce((s,p)=>s+interaction(p),0),avg_score:avg(rows),
   missing_insights:rows.filter(p=>available.every(k=>p[k]==null)).length,
   partial_insights:rows.filter(p=>available.some(k=>p[k]==null)).length,
   views_observed:rows.filter(p=>p.views!=null&&!p.views_missing).length};
}
function breakdown(rows,k){const groups=new Map();for(const row of rows){const key=row[k]||'unlabelled';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return [...groups].map(([name,posts])=>({name,items:posts.length,avg_score:avg(posts),avg_interactions:Math.round(posts.reduce((n,p)=>n+interaction(p),0)/posts.length*10)/10,views:sum(posts,'views')})).sort((a,b)=>(b.avg_score??-1)-(a.avg_score??-1));}
function rank(rows,k,n=10){return [...rows].filter(p=>p[k]!=null).sort((a,b)=>num(b[k])-num(a[k])).slice(0,n);}
export function selectAnalytics(d,r,plat){
 const history = d.history_posts || d.posts || [], start=d.history_from || d.window?.from, end=d.window?.to;
 const complete=!!start&&!!end&&r.from>=start&&r.to<=end;
 const inRange=(p,a=r.from,b=r.to)=>p.date>=a&&p.date<=b;
 const rows=history.filter(p=>inRange(p)), prevEnd=add(r.from,-1),prevStart=add(prevEnd,1-r.days), previous=history.filter(p=>inRange(p,prevStart,prevEnd));
 const total=summarize(rows,plat), prior=summarize(previous,plat);
 const comparable=complete&&prevStart>=start&&total.partial_insights===0&&prior.partial_insights===0;
 total.trend_views_pct=comparable?pct(total.views,prior.views):null;total.trend_score_pct=comparable?pct(total.avg_score,prior.avg_score):null;
 // Preserve the generator's explicitly validated comparison for the exact default period.
 if(r.from===d.window?.from&&r.to===d.window?.to&&d.month){total.trend_views_pct=d.month.trend_views_pct; total.trend_score_pct=d.month.trend_score_pct;}
 const daily={};for(const p of rows){const a=daily[p.date]??={date:p.date,items:0,views:0,interactions:0,views_observed:0};a.items++;a.views+=num(p.views);a.interactions+=interaction(p);if(p.views!=null&&!p.views_missing)a.views_observed++;}
 // Only selected dates are charted; dates beyond the snapshot coverage are not synthesized.
 const days=[];const a=start&&r.from<start?start:r.from,b=end&&r.to>end?end:r.to;
 if(a<=b){for(let t=stamp(a);t<=stamp(b);t+=DAY){const s=date(t);days.push(daily[s]||{date:s,items:0,views:0,interactions:0,views_observed:0});}}
 const replyRows=(d.history_replies||[]).filter(p=>inRange(p)); const hasReplyHistory=Array.isArray(d.history_replies);
 const defaultRange=r.from===d.window?.from&&r.to===d.window?.to;
 return {...d,range:r,rangeComplete:complete,historyStart:start,historyEnd:end,month:total,week:total,posts:rows,daily:days,by_pillar:plat==='threads'?[]:breakdown(rows,'pillar'),by_format:breakdown(rows,'format'),top_selected:rank(rows,'score'),top_selected_views:rank(rows,'views'),top_replies:hasReplyHistory?rank(replyRows,'score',5):(defaultRange?d.top_replies:[]),replies_30d:hasReplyHistory?(plat==='threads'?summarize(replyRows,plat):null):(defaultRange?d.replies_30d:null),recommendations:defaultRange?d.recommendations:[],coverage:{...d.coverage,comparison_complete:comparable||defaultRange&&d.coverage?.comparison_complete}};
}
