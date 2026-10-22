import assert from 'node:assert/strict';
import test from 'node:test';
import feature from '../lib/agent-features/shutdown-review.js';
import {createAgentFeatureFixture,createMemoryAgentBackend,deferred} from './helpers/agent-feature-fixture.js';
const id=(s:string)=>s.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0];
const state=async(f:ReturnType<typeof createAgentFeatureFixture>):Promise<any>=>f.store().read('state');
const record=async(f:ReturnType<typeof createAgentFeatureFixture>,key:string)=>JSON.parse(await f.run('export '+key)).record;
const esc=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\|/g,'\\|');
test('catalog closure requires every disposition and restart cue; changes reopen and invalidate loop evidence',async()=>{
 const f=createAgentFeatureFixture(feature),day=id(await f.run('start 2026-10-22'));
 await f.run(`loop ${day} add Finish installation examples`);const loop=(await record(f,day)).loops[0].id;
 assert.match(await f.run(`close ${day}`),/incomplete/);
 const before=await state(f);assert.match(await f.run(`disposition ${day} ${loop} | defer | none | Reason`),/require/);assert.deepEqual(await state(f),before);
 await f.run(`disposition ${day} ${loop} | defer | 2026-10-23 | Need one clean install example`);
 await f.run(`first-step ${day} | Run a clean install and capture the exact commands`);
 await f.run(`question ${day} add Which version is supported?`);
 assert.match(await f.run(`close ${day}`),/closed/);
 const check=await f.run(`check ${day}`);assert.match(check,/2026-10-23/);assert.match(check,/not claimed answered/);assert.match(check,/No external task/);
 await f.run(`loop ${day} edit ${loop} | Test another platform`);
 const changed=await record(f,day);assert.equal(changed.closedAt,null);assert.equal(changed.loops[0].disposition,null);
 await f.run(`disposition ${day} ${loop} | done | none | Tested locally`);await f.run(`close ${day}`);
 await f.run(`edit ${day} day | 2026-10-24`);assert.equal((await record(f,day)).loops[0].disposition,null);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test('every accepted field edits/removes, strict enum/date/schema preservation and scope isolation',async()=>{
 const f=createAgentFeatureFixture(feature),day=id(await f.run('start 2026-10-22'));await f.run(`loop ${day} add One`);await f.run(`question ${day} add Why?`);
 let r=await record(f,day);const loop=r.loops[0].id,q=r.questions[0].id;
 for(const c of [`question ${day} edit ${q} | Which?`,`disposition ${day} ${loop} | wait | 2026-10-23 | Waiting`,`clear-disposition ${day} ${loop} confirm`,`first-step ${day} | Begin`,`clear ${day} first-step confirm`,`loop ${day} remove ${loop} confirm`,`question ${day} remove ${q} confirm`])assert.match(await f.run(c),/Saved privately/);
 assert.equal((await record(f,day)).loops.length,0);assert.match(await f.run('show '+day,{owner:{teamId:f.owner.teamId,userId:'UOTHER'}}),/not found/);
 await f.run(`loop ${day} add New`);await f.run(`disposition ${day} ${(await record(f,day)).loops[0].id} | done | none | Done`);
 const good=await state(f);
 for(const mutate of [(s:any)=>s.records[0].loops[0].disposition.kind=['done'],(s:any)=>s.records[0].day='2026-02-30',(s:any)=>s.records[0].closedAt='2026-10-22T15:00:00Z',(s:any)=>s.records[0].loops[0].disposition.nextReview='2026-10-23',(s:any)=>s.records[0].unknown=true]) {
  const bad=structuredClone(good);mutate(bad);const raw=JSON.stringify(bad);f.backend.data.set(f.key('state'),raw);assert.match(await f.run(`delete ${day} confirm`),/Invalid/);assert.equal(f.backend.data.get(f.key('state')),raw);
 }
});
test('real CAS: a later loop edit defeats old close; unrelated-day changes retry; ceiling removal stays guarded',async()=>{
 let pause=false;let enter=deferred<void>(),resume=deferred<void>();
 const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;enter.resolve();await resume.promise;}}});
 const f=createAgentFeatureFixture(feature,{backend}),a=id(await f.run('start 2026-10-22')),b=id(await f.run('start 2026-10-23'));
 await f.run(`loop ${a} add Old`);const loop=(await record(f,a)).loops[0].id;await f.run(`disposition ${a} ${loop} | done | none | Done`);await f.run(`first-step ${a} | Start`);
 pause=true;const close=f.run(`close ${a}`);await enter.promise;await f.run(`loop ${a} edit ${loop} | New work`);resume.resolve();assert.match(await close,/changed/);assert.equal((await record(f,a)).closedAt,null);
 enter=deferred();resume=deferred();pause=true;const next=f.run(`first-step ${a} | Another start`);await enter.promise;await f.run(`first-step ${b} | Other day`);resume.resolve();assert.match(await next,/Saved privately/);assert.equal((await record(f,b)).firstStep,'Other day');
 const s=await state(f);s.records[0].revision=Number.MAX_SAFE_INTEGER;backend.data.set(f.key('state'),JSON.stringify(s));
 enter=deferred();resume=deferred();pause=true;const removal=f.run(`loop ${a} remove ${loop} confirm`);await enter.promise;await f.run(`loop ${a} edit ${loop} | Latest`);resume.resolve();assert.match(await removal,/changed/);assert.equal((await record(f,a)).loops[0].text,'Latest');
});
test('lossless maximum Unicode/escaping retrieval and all mandatory closure fields after saturated admission',async()=>{
 const f=createAgentFeatureFixture(feature),days:string[]=[];
 for(let d=1;d<=20;d++){
  const out=await f.run(`start 2026-10-${String(d).padStart(2,'0')}`);if(!out.includes('Saved privately'))break;
  const day=id(out);days.push(day);
  for(let l=0;l<20;l++){if(!(await f.run(`loop ${day} add ${esc('\\'.repeat(300))}`)).includes('Saved privately'))break;}
  if(!(await f.run(`question ${day} add ${esc('漢😀|\\'.repeat(20))}`)).includes('Saved privately'))break;
 }
 const saturated=await state(f);assert.ok(saturated.records.flatMap((r:any)=>r.loops).length>20);
 for(const r of saturated.records){for(const l of r.loops)assert.match(await f.run(`disposition ${r.id} ${l.id} | defer | 2026-11-01 | ${esc('\\'.repeat(160))}`),/Saved privately/);assert.match(await f.run(`first-step ${r.id} | ${esc('\\'.repeat(300))}`),/Saved privately/);assert.match(await f.run(`close ${r.id}`),/closed/);}
 const finished=await state(f);assert.ok(Buffer.byteLength(JSON.stringify(finished))<=49152);assert.ok(Buffer.byteLength(JSON.stringify(finished))>32768);
 const target=finished.records[0];let out=await f.run(`show ${target.id}`),joined='',pages=0,firstNext='';
 for(;;){assert.ok(out.length<=3500);const next=out.match(/\nNext: (.+)$/)?.[1];joined+=out.split('\n').slice(2).join('\n').replace(/\nNext: .+$/,'');pages++;if(!next)break;firstNext ||= next;out=await f.run(next.replace('/nobo-help agent shutdown-review ',''));assert.ok(pages<20);}
 assert.ok(pages>1);assert.deepEqual(JSON.parse(joined).record,target);assert.deepEqual(JSON.parse(await f.run('export '+target.id)).record,target);
 await f.run(`reopen ${target.id}`);assert.match(await f.run(firstNext.replace('/nobo-help agent shutdown-review ','')),/changed/);
 for(const r of finished.records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});
