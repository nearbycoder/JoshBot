import {randomUUID} from 'node:crypto';
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
 enter=deferred();resume=deferred();pause=true;const removal=f.run(`loop ${a} remove ${loop} confirm`);await enter.promise;assert.match(await f.run(`loop ${a} edit ${loop} | Latest`),/Revision limit/);assert.match(await f.run(`clear ${a} first-step confirm`),/^Saved/);resume.resolve();assert.match(await removal,/changed/);assert.equal((await record(f,a)).loops[0].text,'New work');assert.equal((await record(f,a)).firstStep,'');
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
test('otherwise valid CLOSED reviews reject impossible and noncanonical timestamps without touching bad bytes',async()=>{
 const f=createAgentFeatureFixture(feature),day=id(await f.run('start 2026-10-22'));
 await f.run(`loop ${day} add Complete local review`);const loop=(await record(f,day)).loops[0].id;
 await f.run(`disposition ${day} ${loop} | done | none | Reviewed locally`);await f.run(`first-step ${day} | Begin tomorrow`);await f.run(`close ${day}`);
 const valid=await state(f);assert.equal(valid.records[0].closedAt,'2026-10-22T15:00:00.000Z');assert.match(await f.run(`check ${day}`),/All required fields are complete/);
 for(const closedAt of ['2026-02-30T15:00:00.000Z','2026-10-22T10:00:00.000-05:00']){
  const bad=structuredClone(valid);bad.records[0].closedAt=closedAt;const raw=JSON.stringify(bad);f.backend.data.set(f.key('state'),raw);
  for(const command of ['list',`show ${day}`,`check ${day}`,`export ${day}`,`delete ${day} confirm`]){
   assert.match(await f.run(command),/Invalid saved shutdown-review schema/);assert.equal(f.backend.data.get(f.key('state')),raw);
  }
 }
});


test('finite revisions prevent paused-CAS constant-clock ABA at record and collection ceilings',async()=>{
 for(const ceiling of ['record','collection','both']){
  let pause=false;const entered=deferred<void>(),release=deferred<void>();
  const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;entered.resolve();await release.promise;}}});
  const f=createAgentFeatureFixture(feature,{backend,now:new Date('2026-10-22T15:00:00Z')});
  const key=id(await f.run('start 2026-10-22'));
  const edit=(key:string,value:string)=>`first-step ${key} | ${value}`;assert.match(await f.run(edit(key,'Original')),/^Saved/);
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
 const edit=(key:string,value:string)=>`first-step ${key} | ${value}`;
 for(const mode of ['unrelated','collection','target-erasure','target-delete']){
  let pause=false;const entered=deferred<void>(),release=deferred<void>();
  const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;entered.resolve();await release.promise;}}});
  const f=createAgentFeatureFixture(feature,{backend});const key=id(await f.run('start 2026-10-22')),other=id(await f.run('start 2026-10-23'));
  assert.match(await f.run(edit(key,'Original')),/^Saved/);
  const s=await state(f);if(mode==='collection')s.revision=Number.MAX_SAFE_INTEGER-1;else if(mode==='unrelated')s.records[1].revision=Number.MAX_SAFE_INTEGER-1;
  else{s.revision=Number.MAX_SAFE_INTEGER;s.records[0].revision=Number.MAX_SAFE_INTEGER;}
  backend.data.set(f.key('state'),JSON.stringify(s));pause=true;
  const pending=f.run(mode==='target-delete'?`delete ${key} confirm`:mode==='target-erasure'?`clear ${key} first-step confirm`:edit(key,'Pending'));
  await entered.promise;
  try{
   if(mode==='target-erasure')assert.match(await f.run(`clear ${key} first-step confirm`),/^Saved/);
   else if(mode==='target-delete')assert.match(await f.run(`delete ${key} confirm`),/^Deleted/);
   else assert.match(await f.run(edit(other,'Winner')),/^Saved/);
   const winner=backend.data.get(f.key('state'));release.resolve();const out=await pending;assert.equal(backend.calls.conflicts,1);
   if(mode==='unrelated'){assert.match(out,/^Saved/);const records=(await state(f)).records;assert.equal(records[0].firstStep,'Pending');assert.equal(records[1].firstStep,'Winner');assert.equal(records[1].revision,Number.MAX_SAFE_INTEGER);}
   else{assert.match(out,/changed|not found|Revision limit/);assert.equal(backend.data.get(f.key('state')),winner);}
  }finally{release.resolve();await pending;}
 }
 const f=createAgentFeatureFixture(feature),key=id(await f.run('start 2026-10-22'));assert.match(await f.run(edit(key,'Original')),/^Saved/);
 const s=await state(f);s.revision=Number.MAX_SAFE_INTEGER;s.records[0].revision=Number.MAX_SAFE_INTEGER;f.backend.data.set(f.key('state'),JSON.stringify(s));const before=f.backend.data.get(f.key('state')),writes=f.backend.calls.writes;
 for(const cmd of [edit(key,'Blocked'),'start 2026-10-23']){assert.match(await f.run(cmd),/Revision limit/);assert.equal(f.backend.data.get(f.key('state')),before);assert.equal(f.backend.calls.writes,writes);}
 assert.match(await f.run(`show ${key}`),/^Revision/);assert.equal(JSON.parse(await f.run(`export ${key}`)).record.id,key);
 assert.match(await f.run(`clear ${key} first-step confirm`),/^Saved/);assert.equal((await state(f)).records[0].firstStep,'');assert.equal((await state(f)).revision,Number.MAX_SAFE_INTEGER);
 assert.match(await f.run(`delete ${key} confirm`),/^Deleted/);assert.equal((await state(f)).records.length,0);
 assert.match(await f.run('start 2026-10-22'),/Revision limit/);
});

test('paused close cannot override a successful close and reopen at a constant clock',async()=>{
 let pause=false;const entered=deferred<void>(),release=deferred<void>();
 const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(pause){pause=false;entered.resolve();await release.promise;}}});
 const f=createAgentFeatureFixture(feature,{backend,now:new Date('2026-10-22T15:00:00Z')}),key=id(await f.run('start 2026-10-22'));
 await f.run(`first-step ${key} | Restart`);const s=await state(f);s.revision=Number.MAX_SAFE_INTEGER-1;s.records[0].revision=Number.MAX_SAFE_INTEGER-1;backend.data.set(f.key('state'),JSON.stringify(s));
 pause=true;const pending=f.run(`close ${key}`);await entered.promise;
 try{
  assert.match(await f.run(`close ${key}`),/closed/);assert.match(await f.run(`reopen ${key}`),/^Saved/);const winner=backend.data.get(f.key('state'));release.resolve();assert.match(await pending,/changed|Revision limit/);assert.equal(backend.data.get(f.key('state')),winner);assert.equal((await state(f)).records[0].closedAt,null);
  const writes=backend.calls.writes;assert.match(await f.run(`close ${key}`),/Revision limit/);assert.equal(backend.calls.writes,writes);
 }finally{release.resolve();await pending;}
});


async function legacyAggregate(){
 const f=createAgentFeatureFixture(feature),key=id(await f.run('start 2026-10-22')),template=(await state(f)).records[0];
 const records=Array.from({length:20},(_,i)=>({...structuredClone(template),id:randomUUID(),day:`2026-10-${String(i+1).padStart(2,'0')}`,loops:Array.from({length:20},()=>({id:randomUUID(),text:'\\'.repeat(300),disposition:null}))}));
 const saved={version:1,revision:1,records};f.backend.data.set(f.key('state'),JSON.stringify(saved));
 assert.ok(Buffer.byteLength(JSON.stringify(saved))<512000);assert.ok(Buffer.byteLength(JSON.stringify({...saved,records:records.slice(1)}))>49152);
 return {f,saved};
}
test('confirmed root deletion recovers readable legacy aggregates to empty with exact surviving snapshots',async()=>{
 const {f,saved}=await legacyAggregate(),target=saved.records.find((r:any)=>r)!;
 const before=f.backend.data.get(f.key('state')),sources=[...f.backend.data].filter(([k])=>k!==f.key('state')),writes=f.backend.calls.writes;
 assert.match(await f.run('list'),/Current list/);
 for(const r of saved.records)assert.deepEqual(JSON.parse(await f.run(`export ${r.id}`)).record,r);
 for(const command of [`start 2026-11-01`,`loop ${target.id} edit ${target.loops[0].id} | Edit`,`first-step ${target.id} | Restart`,`loop ${target.id} remove ${target.loops[0].id} confirm`]){
  assert.doesNotMatch(await f.run(command),/^Saved/);assert.equal(f.backend.data.get(f.key('state')),before);assert.equal(f.backend.calls.writes,writes);
 }
 for(const scope of [{teamId:'TOTHER',userId:f.owner.userId},{teamId:f.owner.teamId,userId:'UOTHER'}]){
  assert.match(await f.run(`delete ${target.id} confirm`,{owner:scope}),/not found/);assert.equal(f.backend.data.get(f.key('state')),before);
 }
 // The recovery path must also remain usable when both counters are saturated.
 saved.revision=Number.MAX_SAFE_INTEGER;for(const r of saved.records)r.revision=Number.MAX_SAFE_INTEGER;f.backend.data.set(f.key('state'),JSON.stringify(saved));
 let expected=structuredClone(saved.records);
 for(const target of saved.records){const previous=f.backend.data.get(f.key('state'))!,count=f.backend.calls.writes,reads=f.calls.readContext;
  assert.match(await f.run(`delete ${target.id} confirm`),/^Deleted/);expected=expected.filter((r:any)=>r.id!==target.id);const current=await state(f);
  assert.deepEqual(current,{version:1,revision:Number.MAX_SAFE_INTEGER,records:expected});assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!)<Buffer.byteLength(previous));assert.equal(f.backend.calls.writes,count+1);assert.equal(f.calls.readContext,reads);
  assert.deepEqual([...f.backend.data].filter(([k])=>k!==f.key('state')),sources);
 }
});

test('legacy root recovery binds its intended record across mutation/deletion races and preserves malformed raw data',async()=>{
 const {f,saved}=await legacyAggregate(),target=saved.records[0],other=saved.records[1],original=f.backend.compareSet;
 for(const mode of ['target-mutation','target-delete','unrelated-mutation','unrelated-delete']){
  f.backend.data.set(f.key('state'),JSON.stringify(saved));let once=true,winning:any;const conflicts=f.backend.calls.conflicts;
  f.backend.compareSet=async(k,p,n,ttl)=>{
   if(once){once=false;const key=mode.startsWith('target')?target.id:other.id;
    if(mode.endsWith('delete'))assert.match(await f.run(`delete ${key} confirm`),/^Deleted/);
    else await f.store().update('state',saved,(raw:any)=>{
     // Simulate a schema-valid legacy writer using the real scoped CAS store;
     // ordinary feature edits correctly remain blocked above the feature quota.
     const next=structuredClone(raw),r=next.records.find((r:any)=>r.id===key);r.firstStep='Legacy concurrent edit';r.revision++;next.revision++;return {value:next,result:null};
    });winning=await state(f);
   }return original(k,p,n,ttl);
  };
  const out=await f.run(`delete ${target.id} confirm`);assert.equal(f.backend.calls.conflicts,conflicts+1);
  if(mode.startsWith('target')){assert.match(out,/changed|not found/);assert.deepEqual(await state(f),winning);}
  else{assert.match(out,/^Deleted/);assert.deepEqual(await state(f),{...winning,revision:winning.revision+1,records:winning.records.filter((r:any)=>r.id!==target.id)});}
 }
 f.backend.compareSet=original;
 for(const mutate of [(s:any)=>s.unrecognized=true,(s:any)=>s.records[0].unrecognized=true,(s:any)=>s.records[0].revision=0]){
  const bad=structuredClone(saved);mutate(bad);const raw=' \n'+JSON.stringify(bad)+' \t';f.backend.data.set(f.key('state'),raw);const writes=f.backend.calls.writes;
  for(const command of ['list',`delete ${target.id} confirm`]){assert.doesNotMatch(await f.run(command),/^Deleted|^Current list/);assert.equal(f.backend.data.get(f.key('state')),raw);assert.equal(f.backend.calls.writes,writes);}
 }
});
