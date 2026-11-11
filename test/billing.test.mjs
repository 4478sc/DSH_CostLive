import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { normalizeBilling, shanghaiDay, subscriptionReport, billingRuntimeSource } from '../src/billing.mjs';
import { providerUsage } from '../src/billing-report.mjs';
import { loadBilling, saveBilling } from '../src/billing-config.mjs';
import { collectLiveReport, renderLiveDocument, renderLiveFragment } from '../src/live.mjs';
import { startLiveServer } from '../src/live-server.mjs';
import { toCsv } from '../src/report-data.mjs';
import { renderHtml } from '../src/report-html.mjs';
import { timeRangeRuntimeSource } from '../src/time-range.mjs';
import { MESSAGES } from '../src/i18n.mjs';
import { realBody } from '../src/billing-ui.mjs';
import { main } from '../src/cli.mjs';
const at = (day) => Date.parse(day + 'T12:00:00+08:00');
const config = (start = '2026-11-01', a = 30, b = 60) => normalizeBilling({ mode:'real', subscriptions:{opencode:[{effectiveFrom:start,monthlyUsd:a}],codex:[{effectiveFrom:start,monthlyUsd:b}]} });
const tokens = (n) => ({uncachedInputTokens:n,outputTokens:0,cacheWriteTokens:0,cacheReadTokens:0,totalTokens:n});

test('billing configuration validates histories, dates, cents and month-boundary changes', () => {
  assert.equal(normalizeBilling().mode,'usage');
  assert.throws(() => normalizeBilling({mode:'real'}));
  for (const amount of [-1, NaN, Infinity, '20', 0.001]) assert.throws(() => config('2026-11-01',amount));
  assert.throws(() => config('2026-02-30'));
  const value = config(); value.subscriptions.codex.push({effectiveFrom:'2026-12-02',monthlyUsd:50}); assert.throws(() => normalizeBilling(value));
  value.subscriptions.codex[1].effectiveFrom = '2026-12-01'; assert.equal(normalizeBilling(value).subscriptions.codex.length,2);
  value.subscriptions.codex[1].effectiveFrom = '2026-11-01'; assert.throws(() => normalizeBilling(value));
});

test('natural month day amounts reconcile exactly for 28/29/30/31 days', () => {
  for (const [month,days] of [['2026-02',28],['2028-02',29],['2026-11',30],['2026-12',31]]) {
    const report = subscriptionReport([],config(month+'-01',19.99,0),{now:at(month+'-'+days)});
    assert.equal(report.days.length,days); assert.equal(report.summary.costMicroUsd,19990000); assert.equal(report.summary.idleMicroUsd,19990000);
    assert.equal(report.summary.tokenPrice.usdMicroPerM,null);
  }
});

test('history changes monthly, cross-month ranges and full current day use Shanghai', () => {
  const billing = config(); billing.subscriptions.codex.push({effectiveFrom:'2026-12-01',monthlyUsd:93});
  const report = subscriptionReport([],billing,{since:'2026-11-30',now:at('2026-12-02')});
  assert.equal(report.summary.costMicroUsd,3000000+6000000+Math.round(30000000*2/31));
  assert.equal(shanghaiDay(Date.parse('2026-11-01T15:59:59Z')),'2026-11-01');
  assert.equal(shanghaiDay(Date.parse('2026-11-01T16:00:00Z')),'2026-11-02');
  assert.equal(subscriptionReport([],config(),{now:Date.parse('2026-11-01T16:00:00Z'),range:'today'}).summary.costMicroUsd,3000000);
  assert.equal(subscriptionReport([],config('2026-11-10'),{now:at('2026-11-12')}).summary.costMicroUsd,9000000);
  assert.equal(subscriptionReport([],config(),{now:at('2026-11-12'),range:'7d'}).days.length,7);
});

test('provider aliases combine sources without repeating subscriptions or invoice overlays', () => {
  const sample = (provider,n) => ({provider,time:at('2026-11-01'),buckets:tokens(n),priceKey:'usd-example',priced:true,costMicroUsd:999999});
  const results = [{meta:{source:'host',id:'one'},analysis:{records:[sample('host-codex',100)]}},{meta:{source:'vm',id:'two'},analysis:{records:[sample('openai',200)]}},{meta:{source:'vm',id:'three'},localAnalysis:{records:[sample('opencode-go',400)]},analysis:{records:[sample('opencode',1)]}}];
  const usage = providerUsage(results);
  const report = subscriptionReport(usage,config(),{now:at('2026-11-01')});
  assert.equal(report.summary.costMicroUsd,3000000); assert.equal(report.summary.tokens.totalTokens,700);
  assert.equal(report.providers.find((p)=>p.provider==='codex').tokens.totalTokens,300);
  assert.equal(report.providers.find((p)=>p.provider==='codex').tokenPrice.usdMicroPerM,Math.round(2e12/300));
  assert.equal(report.modelCostsAllocated,false); assert.equal(report.sessionCostsAllocated,false);
});

test('other provider currencies remain separate, idle costs enter only the average numerator', () => {
  const usage=[{day:'2026-11-01',provider:'codex',tokens:tokens(1000000),sessionIds:['host:a']},{day:'2026-11-01',provider:'proxy',tokens:tokens(1000000),costMicroCny:2000000,cnyTokens:1000000}];
  const report=subscriptionReport(usage,config(),{now:at('2026-11-02')});
  assert.equal(report.summary.costMicroCny,2000000);assert.equal(report.summary.costMicroUsd,6000000);
  assert.equal(report.summary.tokenPrice.usdMicroPerM,6000000);assert.equal(report.summary.tokenPrice.cnyMicroPerM,2000000);
  assert.equal(report.summary.idleMicroUsd,4000000);
  const missing=subscriptionReport([{day:'2026-10-31',provider:'codex',tokens:tokens(10)}],config(),{now:at('2026-11-01')});
  assert.equal(missing.summary.configured,false);
  assert.equal(missing.summary.tokenPrice.usdMicroPerM,null);
  assert.equal(subscriptionReport([],config(),{since:'2026-11-15',until:'2026-11-16',now:at('2026-11-30')}).summary.costMicroUsd,6000000);
  assert.throws(()=>subscriptionReport([],config(),{since:'2026-02-30',now:at('2026-11-01')}));
});

test('billing runtime produces the same provider/day report in a browser realm', () => {
  const context=vm.createContext({window:{}}); vm.runInContext(billingRuntimeSource(),context);
  const args=[[],config(),{now:at('2026-11-12'),range:'7d'}];
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.DSH_BILLING.calculate(...args))),subscriptionReport(...args));
});

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'costlive-billing-')); const home=join(dir,'home'); const session=join(home,'sessions','workspace','billing-session');mkdirSync(session,{recursive:true});
  const lines=[{type:'session',version:4,id:'billing-session',createdAt:at('2026-10-01'),cwd:'/demo'},{type:'model/selection',seq:0,time:at('2026-11-01'),data:{provider:'opencode-go',model:'demo'}},{type:'assistant/message',seq:1,time:at('2026-11-01'),data:{turn:1,step:1,usage:{inputTokens:500,outputTokens:100}}}];
  writeFileSync(join(session,'session.v4.jsonl.zstd'),Buffer.concat(lines.map((x)=>zstdCompressSync(Buffer.from(JSON.stringify(x)+'\n')))));
  return {dir,home,billingPath:join(dir,'billing.json')};
}

test('local config saves atomically and real live/CSV/static reports use the shared pipeline', () => {
  const f=fixture();try {
    saveBilling(f.billingPath,config()); assert.equal(loadBilling(f.billingPath).mode,'real');
    const report=collectLiveReport({home:f.home,billingPath:f.billingPath,since:'2026-11-01',until:'2026-11-02',official:false});
    assert.equal(report.summary.costUsd,6);assert.equal(report.summary.totalTokens,600);assert.equal(report.sessions.length,0);assert.equal(report.referenceUsage.sessions.length,1);
    assert.match(toCsv(report),/billing_mode/);assert.match(toCsv(report),/TOTAL/);
    const html = renderHtml(report,{locale:'en'});
    assert.match(html,/data-billing-mode="usage"/); assert.match(html,/data-billing-mode="real"/);
    assert.doesNotMatch(html,/data-billing-export|data-billing-import|data-real-export/);
    assert.match(html,/<th class="num">Token<\/th>/);
    assert.match(html,/Costs by provider/);assert.match(renderLiveDocument({report,locale:'en'}),/billing-form/);
    assert.equal(renderLiveFragment(report).dataset.billing.config.mode,'real');
    const output = join(f.dir,'report.json');
    assert.equal(main(['report','--home',f.home,'--billing',f.billingPath,'--since','2026-11-01','--until','2026-11-02','--format','json','--out',output]),0);
    const cli = JSON.parse(readFileSync(output,'utf8')); assert.equal(cli.summary.costUsd,report.summary.costUsd); assert.equal(cli.summary.totalTokens,report.summary.totalTokens);
    assert.throws(()=>collectLiveReport({home:f.home,billingPath:f.billingPath,model:'demo'}),/complete subscription scope/);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('billing API rejects cross-origin, missing header, invalid input and persists valid settings',async () => {
  const f=fixture();const live=await startLiveServer({port:0,open:false,logger:{log(){},warn(){}},reportOptions:{home:f.home,billingPath:f.billingPath,official:false}});
  try {
    const send=(value,headers={})=>fetch(live.url+'api/billing',{method:'PUT',headers:{'Content-Type':'application/json','Origin':live.url.slice(0,-1),'X-CostLive-Settings':'1',...headers},body:JSON.stringify(value)});
    assert.equal((await send(config(),{Origin:'https://evil.example'})).status,403);
    assert.equal((await send(config(),{'X-CostLive-Settings':''})).status,403);
    assert.equal((await send({mode:'real'})).status,400);
    assert.equal((await send(config())).status,200);
    assert.equal(loadBilling(f.billingPath).mode,'real');
    const report=await (await fetch(live.url+'api/report')).json();assert.equal(report.billing.config.mode,'real');assert.equal(report.summary.totalTokens,600);
    const csv=await (await fetch(live.url+'api/report.csv')).text();assert.match(csv,/billing_mode/);
    const mode = (value) => fetch(live.url+'api/billing/mode',{method:'PUT',headers:{'Content-Type':'application/json','Origin':live.url.slice(0,-1),'X-CostLive-Settings':'1'},body:JSON.stringify({mode:value,locale:'en',subscriptions:{codex:[]}})});
    const before = loadBilling(f.billingPath).subscriptions;
    const switched = await mode('usage'); assert.equal(switched.status,200);
    const answer = await switched.json(); assert.equal(answer.fragment.dataset.billing.config.mode,'usage');
    assert.deepEqual(loadBilling(f.billingPath).subscriptions,before);
    assert.equal((await mode('invalid')).status,400);
    assert.equal((await mode('real')).status,200);
    assert.deepEqual(loadBilling(f.billingPath).subscriptions,before);
    assert.equal((await send({...config(),mode:'usage'})).status,200);
    assert.equal((await (await fetch(live.url+'api/report')).json()).billing.config.mode,'usage');
  }finally{await live.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('real-price daily costs reveal seven days at a time without changing totals', () => {
  const dataset = {billing:{config:config('2026-10-01'),usage:[],bounds:{}}};
  const content = {innerHTML:''};
  const doc = {getElementById(id) { if (id === 'dsh-cost-data') return {textContent:JSON.stringify(dataset)}; if(id === 'real-pricing-content') return content; return null; },querySelector(){return null;},querySelectorAll(){return [];} };
  const context = vm.createContext({window:{}}); vm.runInContext(timeRangeRuntimeSource(), context);
  const apply = (pages, range = 'all', showAllDays = false) => context.window.DSH_TIME_RANGE.applyTimeRange(doc,{range,dailyPages:pages,showAllDays,now:at('2026-11-12'),messages:MESSAGES.en});
  const count = () => (content.innerHTML.match(/<tr data-real-day>/g) || []).length;
  const initial = apply(1); assert.equal(count(),7); assert.equal(initial.extra,36); assert.equal(initial.allShown,false);
  assert.match(content.innerHTML,/Show more/); const cost = initial.stats.costMicroUsd;
  const next = apply(2); assert.equal(count(),14); assert.equal(next.extra,29); assert.equal(next.stats.costMicroUsd,cost);
  assert.match(content.innerHTML,/data-days-collapse>Show less/);
  apply(3); assert.equal(count(),21);
  const complete = apply(7); assert.equal(count(),43); assert.equal(complete.allShown,true);
  assert.match(content.innerHTML,/data-days-toggle aria-expanded="true">Show less/);
  apply(1); assert.equal(count(),7);
  const today = apply(7,'today'); assert.equal(count(),1); assert.equal(today.allShown,false); assert.doesNotMatch(content.innerHTML,/data-days-toggle/);
  apply(7,'7d'); assert.equal(count(),7); assert.doesNotMatch(content.innerHTML,/data-days-toggle/);
  apply(2); assert.equal(count(),14); apply(2); assert.equal(count(),14);
  apply(undefined,'all',true); assert.equal(count(),43);
  const real = subscriptionReport([],config('2026-10-01'),{now:at('2026-11-12')});
  const html = realBody(real,'en'); assert.equal((html.match(/<tr data-real-day>/g)||[]).length,7); assert.match(html,/data-days-toggle/); assert.doesNotMatch(html,/max-height:520px/);
  assert.doesNotMatch(realBody(subscriptionReport([],config(),{now:at('2026-11-01')}),'en'),/data-days-toggle/);
});

test('real pricing DOM hook updates cards and providers for every range',()=>{
  const nodes=new Map();const node=()=>({textContent:'',innerHTML:'',hidden:false,setAttribute(){},classList:{toggle(){}}});
  const dataset={billing:{config:config(),usage:[],bounds:{}}};nodes.set('dsh-cost-data',{textContent:JSON.stringify(dataset)});
  for(const id of ['stat-cost','stat-cost-note','stat-tokens','stat-tokens-note','stat-cache-read','stat-cache-read-note','stat-token-price','stat-token-price-note','usage-pricing-content','real-pricing-content'])nodes.set(id,node());
  const doc={getElementById:id=>nodes.get(id),querySelector:()=>null,querySelectorAll:()=>[]};
  const context=vm.createContext({window:{}});vm.runInContext(timeRangeRuntimeSource(),context);
  for(const range of ['all','30d','7d','today']){const result=context.window.DSH_TIME_RANGE.applyTimeRange(doc,{range,now:at('2026-11-12'),messages:MESSAGES.en});assert.equal(result.stats.costMicroUsd,subscriptionReport([],config(),{range,now:at('2026-11-12')}).summary.costMicroUsd);assert.match(nodes.get('real-pricing-content').innerHTML,/Costs by provider/);assert.doesNotMatch(nodes.get('real-pricing-content').innerHTML,/data-real-export/);assert.match(nodes.get('real-pricing-content').innerHTML,/<th class="num">Token<\/th>/);}
});
