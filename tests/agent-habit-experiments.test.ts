import assert from 'node:assert/strict';
import test from 'node:test';
import feature from '../lib/agent-features/habit-experiments.js';
import {createAgentFeatureFixture,createMemoryAgentBackend,deferred} from './helpers/agent-feature-fixture.js';
import {createAgentFeatureServices,createProductionContextAdapters} from '../lib/agent-features/services.js';
import {runFeature} from '../lib/toolbox/core.js';
import {habits} from '../lib/toolbox/habits.js';
const owner={teamId:'THABIT',userId:'UHABIT'},now=new Date('2026-10-22T15:00:00Z');
const id=(s:string)=>s.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0];
const state=async(f:ReturnType<typeof createAgentFeatureFixture>):Promise<any>=>f.store().read('state');
function fixture(backend=createMemoryAgentBackend()) {
 const services=createAgentFeatureServices(backend,owner,new AbortController().signal,{now,timezone:'Pacific/Honolulu',featureId:feature.id},createProductionContextAdapters({redis:async()=>{throw new Error('Unexpected legacy read');}}));
 const f=createAgentFeatureFixture(feature,{backend,services,owner,now,timezone:'Pacific/Honolulu'});return {f,services,key:`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:habits`};
}
async function setup(){const f=fixture();await runFeature(habits,'create Read for 20 minutes | 5',owner,undefined,f.f.backend,now);const h=JSON.parse(f.f.backend.data.get(f.key)!).entries[0].id;const exp=id(await f.f.run('create Reading cue | Put the book beside the kettle'));await f.f.run(`attach ${exp} | toolbox:habits:${h}`);await f.f.run(`windows ${exp} | 2026-10-01 | 2026-10-07 | 2026-10-08 | 2026-10-14`);return {...f,h,exp};}
test('actual habit commands → production adapters/runtime: literal date counts, denominators and frozen before',async()=>{
 const {f,h,exp,key}=await setup();
 for(const day of ['01','03','07','08','10','11','12'])await runFeature(habits,`check ${h} | 2026-10-${day}`,owner,undefined,f.backend,now);
 const before=f.backend.data.get(key);await f.run(`opportunities ${exp} | 7 | 7`);
 const reads=f.calls.readContext,out=await f.run(`compare ${exp}`);assert.equal(f.calls.readContext-reads,1);
 assert.match(out,/Current baseline: recorded 3; opportunities 7; adherence 3\/7 = 42.9%/);assert.match(out,/Intervention: recorded 4; opportunities 7; adherence 4\/7 = 57.1%/);assert.match(out,/2026-10-01, 2026-10-03, 2026-10-07/);assert.match(out,/retrospective/);assert.equal(f.backend.data.get(key),before);
 const frozen=(await state(f)).records[0].before;await runFeature(habits,`check ${h} | 2026-10-02`,owner,undefined,f.backend,now);
 assert.match(await f.run(`compare ${exp}`),/STALE baseline/);assert.deepEqual((await state(f)).records[0].before,frozen);
 await f.run(`edit ${exp} intervention | Place book on desk`);assert.equal((await state(f)).records[0].before,null);
 assert.equal(f.calls.generate,0);assert.equal(f.calls.search,0);
});
test('unknown days, explicit empty zero, zero/unknown denominators, impossible counts and overlap are distinct',async()=>{
 const {f,h,exp,key}=await setup();
 await f.run(`opportunities ${exp} | 0 | 0`);let out=await f.run(`compare ${exp}`);assert.match(out,/recorded 0; opportunities 0; adherence undefined/);
 let source=JSON.parse(f.backend.data.get(key)!);delete source.entries[0].data.days;f.backend.data.set(key,JSON.stringify(source));
 await f.run(`attach ${exp} | toolbox:habits:${h}`);out=await f.run(`compare ${exp}`);assert.match(out,/recorded unknown/);assert.match(out,/unknown \(days absent\)/);
 const before=await state(f);assert.match(await f.run(`windows ${exp} | 2026-10-01 | 2026-10-08 | 2026-10-08 | 2026-10-14`),/overlap/);assert.deepEqual(await state(f),before);
 assert.match(await f.run(`opportunities ${exp} | 8 | 7`),/cannot exceed/);
 source.entries[0].data.days=['2026-10-01'];f.backend.data.set(key,JSON.stringify(source));assert.match(await f.run(`compare ${exp}`),/below recorded/);assert.deepEqual(await state(f),before);
 await f.run(`opportunities ${exp} | unknown | unknown`);await f.run(`reset-snapshot ${exp} confirm`);out=await f.run(`compare ${exp}`);assert.match(out,/recorded 1; opportunities unknown; adherence not shown/);
});
test('selection fingerprint, deleted/renamed source and local edits invalidate comparisons without source writes',async()=>{
 const {f,h,exp,key}=await setup();const listing=await f.run('habits '+exp),fp=listing.match(/e1:[0-9a-f]{64}/)![0];let source=JSON.parse(f.backend.data.get(key)!);source.entries[0].title='A different habit';f.backend.data.set(key,JSON.stringify(source));
 assert.match(await f.run(`attach ${exp} | toolbox:habits:${h} | ${fp}`),/changed/);assert.match(await f.run(`compare ${exp}`),/status source-changed/);
 await f.run(`attach ${exp} | toolbox:habits:${h}`);await f.run(`compare ${exp}`);
 f.backend.data.set(key,JSON.stringify({entries:[]}));assert.match(await f.run(`compare ${exp}`),/status source-absent/);assert.equal((await state(f)).records[0].comparison.baselineDays,null);
 for(const field of ['title','intervention','opportunities','windows','source'])assert.match(await f.run(`clear ${exp} ${field} confirm`),/Saved privately/);
 const r=(await state(f)).records[0];assert.equal(r.before,null);assert.equal(r.comparison,null);assert.equal(r.source,null);assert.equal(r.windows,null);
});
test('deferred compare/delete, cancellation and actual CAS unrelated retries plus changed-record rejection',async()=>{
 const {f,services,exp}=await setup(),raw=await services.readContext(['habit']),original=f.services.readContext;
 let enter=deferred<void>(),read=deferred<typeof raw>();f.services.readContext=async()=>{enter.resolve();return read.promise;};
 const slow=f.run(`compare ${exp}`);await enter.promise;await f.run(`delete ${exp} confirm`);read.resolve(raw);assert.match(await slow,/not found/);assert.equal((await state(f)).records.length,0);
 f.services.readContext=original;const a=id(await f.run('create Again | Cue'));await f.run(`attach ${a} | ${raw[0].id}`);await f.run(`windows ${a} | 2026-10-01 | 2026-10-07 | 2026-10-08 | 2026-10-14`);
 enter=deferred();read=deferred();f.services.readContext=async()=>{enter.resolve();return read.promise;};const ac=new AbortController(),pending=f.run(`compare ${a}`,{signal:ac.signal});await enter.promise;ac.abort();await assert.rejects(pending);read.resolve(raw);await new Promise(r=>setImmediate(r));assert.equal((await state(f)).records[0].before,null);
 f.services.readContext=original;const b=id(await f.run('create Unrelated | Another cue'));const originalCAS=f.backend.compareSet;let mode='unrelated';
 f.backend.compareSet=async(k,p,n,t)=>{if(mode){const next=JSON.parse(p!),r=next.records.find((r:any)=>r.id===(mode==='unrelated'?b:a));r.title='Changed concurrently';r.revision++;f.backend.data.set(k,JSON.stringify(next));mode='';}return originalCAS(k,p,n,t);};
 assert.match(await f.run(`compare ${a}`),/status current/);assert.equal((await state(f)).records.find((r:any)=>r.id===b).title,'Changed concurrently');
 mode='same';assert.match(await f.run(`compare ${a}`),/changed/);
});
test('strict source/state shapes, normalized literal date metadata, complete 100-habit discovery and scope isolation',async()=>{
 const {f,key,exp}=await setup();const good=await state(f);
 for(const mutate of [(s:any)=>s.records[0].windows.baselineStart='2026-02-30',(s:any)=>s.records[0].source.evidence.sources[0].metadata.days='2026-10-01',(s:any)=>s.records[0].opportunities={baseline:'7',intervention:7},(s:any)=>s.records[0].revision=0]){
  const bad=structuredClone(good);mutate(bad);const raw=JSON.stringify(bad);f.backend.data.set(f.key('state'),raw);assert.match(await f.run(`delete ${exp} confirm`),/Invalid|invalid/);assert.equal(f.backend.data.get(f.key('state')),raw);
 }
 f.backend.data.set(f.key('state'),JSON.stringify(good));
 const entries=Array.from({length:100},(_,i)=>({id:'h'+i,title:'Habit '+i,body:'',data:{target:5,days:['2026-10-01','2026-10-01']},createdAt:now.toISOString(),updatedAt:now.toISOString()}));f.backend.data.set(key,JSON.stringify({entries}));
 let out=await f.run('habits '+exp),all='',n=0;for(;;){assert.ok(out.length<=3500);all+=out;const next=out.match(/\nNext: (.+)$/)?.[1];if(!next)break;out=await f.run(next.replace('/nobo-help agent habit-experiments ',''));assert.ok(++n<30);}
 for(const e of entries)assert.ok(all.includes('toolbox:habits:'+e.id+' ·'));assert.match(await f.run(`show ${exp}`,{owner:{teamId:'TOTHER',userId:owner.userId}}),/not found/);
 const malformed={...entries[0],data:{target:5,days:['2026-02-30']}};f.backend.data.set(key,JSON.stringify({entries:[malformed]}));assert.match(await f.run('habits '+exp),/could not be read/);assert.deepEqual(await state(f),good);
});
test('reserved source replacements and both 90-day observations fit after saturation; lossless stamped record retrieval',async()=>{
 const {f,key}=fixture();const days=Array.from({length:180},(_,i)=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10));
 f.backend.data.set(key,JSON.stringify({entries:[{id:'max',title:'漢'.repeat(300),body:'',data:{target:7,days},updatedAt:now.toISOString(),createdAt:now.toISOString()}]}));
 const accepted:string[]=[];for(let i=0;i<12;i++){const key=id(await f.run('create '+('\\\\'.repeat(120))+' | '+('\\\\'.repeat(300))));const out=await f.run(`attach ${key} | toolbox:habits:max`);if(!out.includes('Saved privately'))break;accepted.push(key);}
 assert.ok(accepted.length>=2&&accepted.length<12);
 for(const key of accepted){assert.match(await f.run(`windows ${key} | 2026-01-01 | 2026-03-31 | 2026-04-01 | 2026-06-29`),/Saved privately/);assert.match(await f.run(`opportunities ${key} | 90 | 90`),/Saved privately/);assert.match(await f.run(`compare ${key}`),/recorded 90/);assert.match(await f.run(`attach ${key} | toolbox:habits:max`),/Saved privately/);assert.match(await f.run(`compare ${key}`),/recorded 90/);}
 const r=(await state(f)).records[0];let out=await f.run('show '+r.id),body='',nextCommand='',count=0;
 for(;;){assert.ok(out.length<=3500);body+=out.split('\n').slice(2).join('\n').replace(/\nNext: .+$/,'');const next=out.match(/\nNext: (.+)$/)?.[1];if(!next)break;nextCommand ||=next;out=await f.run(next.replace('/nobo-help agent habit-experiments ',''));assert.ok(++count<20);}
 assert.deepEqual(JSON.parse(body).record,r);assert.deepEqual(JSON.parse(await f.run('export '+r.id)).record,r);
 await f.run(`reset-snapshot ${r.id} confirm`);assert.match(await f.run(nextCommand.replace('/nobo-help agent habit-experiments ','')),/changed/);
 for(const r of (await state(f)).records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});

test('saved comparisons validate both baseline observations and intervention counts on every read and mutation',async()=>{
 const {f,h,exp}=await setup();await runFeature(habits,`check ${h} | 2026-10-01`,owner,undefined,f.backend,now);
 assert.match(await f.run(`opportunities ${exp} | 1 | 1`),/^Saved/);assert.match(await f.run(`compare ${exp}`),/recorded 1/);
 const good=await state(f);
 const variants=[
  (r:any)=>{r.comparison.status='baseline-changed';r.comparison.baselineDays=['2026-10-01','2026-10-02'];},
  (r:any)=>{r.comparison.status='baseline-changed';r.before.baselineDays=['2026-10-01','2026-10-02'];},
  (r:any)=>{r.before.baselineDays=r.comparison.baselineDays=['2026-10-01','2026-10-02'];},
  (r:any)=>r.comparison.interventionDays=['2026-10-08','2026-10-09'],
  (r:any)=>r.opportunities.baseline=0,
  (r:any)=>r.opportunities.intervention=8,
  (r:any)=>r.comparison.baselineDays=['2026-10-02'], // current must match frozen
  (r:any)=>r.comparison.status='baseline-changed', // changed must differ
  (r:any)=>{r.comparison.status='source-changed';r.comparison.interventionDays=null;},
  (r:any)=>{r.comparison.status='source-absent';r.comparison.baselineDays=null;r.comparison.interventionDays=null;},
  (r:any)=>{r.comparison.status='source-changed';r.comparison.baselineDays=null;r.comparison.interventionDays=null;r.comparison.sourceFingerprint=null;},
  (r:any)=>{r.comparison.status='source-absent';r.comparison.baselineDays=null;r.comparison.interventionDays=null;r.comparison.sourceFingerprint=null;r.opportunities.baseline=0;},
  (r:any)=>{r.comparison.status='baseline-changed';r.comparison.baselineDays=['2026-02-30'];},
  (r:any)=>{r.comparison.status='baseline-changed';r.comparison.baselineDays=['2026-10-01T00:00:00Z'];},
  (r:any)=>{r.comparison.status='baseline-changed';r.comparison.baselineDays=['2026-10-02','2026-10-01'];},
  (r:any)=>{r.comparison.status='baseline-changed';r.comparison.baselineDays=['2026-10-01','2026-10-01'];},
 ];
 for(const mutate of variants){const bad=structuredClone(good);mutate(bad.records[0]);const raw=' \n'+JSON.stringify(bad)+' \t';f.backend.data.set(f.key('state'),raw);const writes=f.backend.calls.writes,reads=f.calls.readContext;
  for(const command of ['list',`show ${exp}`,`report ${exp}`,`export ${exp}`,`edit ${exp} title | Valid title`,`opportunities ${exp} | 7 | 7`,`reset-snapshot ${exp} confirm`,`compare ${exp}`,`delete ${exp} confirm`]){
   assert.doesNotMatch(await f.run(command),/^Saved|^Deleted|^Revision|^Current list/);assert.equal(f.backend.data.get(f.key('state')),raw);assert.equal(f.backend.calls.writes,writes);assert.equal(f.calls.readContext,reads);
  }
 }
});

test('valid changed baseline, absent/changed sources, unknown dates and empty observations retain distinct meanings',async()=>{
 const {f,h,exp,key}=await setup();await runFeature(habits,`check ${h} | 2026-10-01`,owner,undefined,f.backend,now);
 assert.match(await f.run(`opportunities ${exp} | 2 | 0`),/^Saved/);assert.match(await f.run(`compare ${exp}`),/status current/);
 const before=(await state(f)).records[0].before;
 await runFeature(habits,`check ${h} | 2026-10-02`,owner,undefined,f.backend,now);
 assert.match(await f.run(`compare ${exp}`),/2\/2 = 100.0%/);assert.equal((await state(f)).records[0].comparison.status,'baseline-changed');assert.deepEqual((await state(f)).records[0].before,before);
 const saved=f.backend.data.get(f.key('state'));assert.match(await f.run(`opportunities ${exp} | 1 | 0`),/below recorded/);assert.equal(f.backend.data.get(f.key('state')),saved);
 let source=JSON.parse(f.backend.data.get(key)!);source.entries[0].title='Changed source';f.backend.data.set(key,JSON.stringify(source));assert.match(await f.run(`compare ${exp}`),/status source-changed/);
 assert.equal((await state(f)).records[0].comparison.baselineDays,null);f.backend.data.set(key,JSON.stringify({entries:[]}));assert.match(await f.run(`compare ${exp}`),/status source-absent/);
 for(const days of [undefined,[]]){
  if(days===undefined)delete source.entries[0].data.days;else source.entries[0].data.days=days;
  f.backend.data.set(key,JSON.stringify(source));assert.match(await f.run(`attach ${exp} | toolbox:habits:${h}`),/^Saved/);
  assert.match(await f.run(`opportunities ${exp} | 0 | unknown`),/^Saved/);const rawSource=f.backend.data.get(key);
  const out=await f.run(`compare ${exp}`);assert.match(out,days===undefined?/recorded unknown; opportunities 0; adherence unknown/:/recorded 0; opportunities 0; adherence undefined/);assert.match(out,/opportunities unknown; adherence not shown/);assert.equal(f.backend.data.get(key),rawSource);
 }
});


test('finite revisions prevent paused-CAS constant-clock ABA at record and collection ceilings',async()=>{
 for(const ceiling of ['record','collection','both']){
  let pause=false;const entered=deferred<void>(),release=deferred<void>();
  const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;entered.resolve();await release.promise;}}});
  const f=createAgentFeatureFixture(feature,{backend,now:new Date('2026-10-22T15:00:00Z')});
  const key=id(await f.run('create Original | cue'));
  const edit=(key:string,value:string)=>`edit ${key} title | ${value}`;assert.match(await f.run(edit(key,'Original')),/^Saved/);
  const s=await state(f);if(ceiling!=='record')s.revision=Number.MAX_SAFE_INTEGER-1;if(ceiling!=='collection')s.records[0].revision=Number.MAX_SAFE_INTEGER-1;backend.data.set(f.key('state'),JSON.stringify(s));
  pause=true;const pending=f.run(edit(key,'Old intent'));await entered.promise;
  try{
   assert.match(await f.run(edit(key,'Winning change')),/^Saved/);const winner=backend.data.get(f.key('state')),writes=backend.calls.writes;
   assert.match(await f.run(edit(key,'Original')),/Revision limit/);assert.equal(backend.calls.writes,writes);assert.equal(backend.data.get(f.key('state')),winner);
   release.resolve();assert.match(await pending,/changed|Revision limit/);assert.equal(backend.data.get(f.key('state')),winner);assert.equal(backend.calls.conflicts,1);
  }finally{release.resolve();await pending;}
 }
});

test('ceiling erasure remains exact, unrelated exhausted records do not block edits, collection ceiling rechecks on retry',async()=>{
 const edit=(key:string,value:string)=>`edit ${key} title | ${value}`;
 for(const mode of ['unrelated','collection','target-erasure','target-delete']){
  let pause=false;const entered=deferred<void>(),release=deferred<void>();
  const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;entered.resolve();await release.promise;}}});
  const f=createAgentFeatureFixture(feature,{backend});const key=id(await f.run('create Original | cue')),other=id(await f.run('create Other | cue'));
  assert.match(await f.run(edit(key,'Original')),/^Saved/);
  const s=await state(f);if(mode==='collection')s.revision=Number.MAX_SAFE_INTEGER-1;else if(mode==='unrelated')s.records[1].revision=Number.MAX_SAFE_INTEGER-1;
  else{s.revision=Number.MAX_SAFE_INTEGER;s.records[0].revision=Number.MAX_SAFE_INTEGER;}
  backend.data.set(f.key('state'),JSON.stringify(s));pause=true;
  const pending=f.run(mode==='target-delete'?`delete ${key} confirm`:mode==='target-erasure'?`clear ${key} title confirm`:edit(key,'Pending'));
  await entered.promise;
  try{
   if(mode==='target-erasure')assert.match(await f.run(`clear ${key} title confirm`),/^Saved/);
   else if(mode==='target-delete')assert.match(await f.run(`delete ${key} confirm`),/^Deleted/);
   else assert.match(await f.run(edit(other,'Winner')),/^Saved/);
   const winner=backend.data.get(f.key('state'));release.resolve();const out=await pending;assert.equal(backend.calls.conflicts,1);
   if(mode==='unrelated'){assert.match(out,/^Saved/);const records=(await state(f)).records;assert.equal(records[0].title,'Pending');assert.equal(records[1].title,'Winner');assert.equal(records[1].revision,Number.MAX_SAFE_INTEGER);}
   else{assert.match(out,/changed|not found|Revision limit/);assert.equal(backend.data.get(f.key('state')),winner);}
  }finally{release.resolve();await pending;}
 }
 const f=createAgentFeatureFixture(feature),key=id(await f.run('create Original | cue'));assert.match(await f.run(edit(key,'Original')),/^Saved/);
 const s=await state(f);s.revision=Number.MAX_SAFE_INTEGER;s.records[0].revision=Number.MAX_SAFE_INTEGER;f.backend.data.set(f.key('state'),JSON.stringify(s));const before=f.backend.data.get(f.key('state')),writes=f.backend.calls.writes;
 for(const cmd of [edit(key,'Blocked'),'create Other | cue']){assert.match(await f.run(cmd),/Revision limit/);assert.equal(f.backend.data.get(f.key('state')),before);assert.equal(f.backend.calls.writes,writes);}
 assert.match(await f.run(`show ${key}`),/^Revision/);assert.equal(JSON.parse(await f.run(`export ${key}`)).record.id,key);
 assert.match(await f.run(`clear ${key} title confirm`),/^Saved/);assert.equal((await state(f)).records[0].title,'');assert.equal((await state(f)).revision,Number.MAX_SAFE_INTEGER);
 assert.match(await f.run(`delete ${key} confirm`),/^Deleted/);assert.equal((await state(f)).records.length,0);
 assert.match(await f.run('create Original | cue'),/Revision limit/);
});

test('known target or collection revision exhaustion rejects selection and observations before reading habits',async()=>{
 const {f,h,exp}=await setup(),good=await state(f);
 for(const ceiling of ['record','collection']){const s=structuredClone(good);if(ceiling==='record')s.records[0].revision=Number.MAX_SAFE_INTEGER;else s.revision=Number.MAX_SAFE_INTEGER;const raw=JSON.stringify(s);f.backend.data.set(f.key('state'),raw);const calls={...f.calls},cas=f.backend.calls.compareSets;
  for(const command of [`attach ${exp} | toolbox:habits:${h}`,`freeze ${exp}`,`compare ${exp}`]){
   assert.match(await f.run(command),/Revision limit/);assert.deepEqual(f.calls,calls);assert.equal(f.backend.calls.compareSets,cas);assert.equal(f.backend.data.get(f.key('state')),raw);
  }
 }
});
