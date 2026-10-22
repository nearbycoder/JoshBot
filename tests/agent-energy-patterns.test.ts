import assert from 'node:assert/strict';
import test from 'node:test';
import feature from '../lib/agent-features/energy-patterns.js';
import {createAgentFeatureFixture,createMemoryAgentBackend,deferred} from './helpers/agent-feature-fixture.js';
import {createAgentFeatureServices,createProductionContextAdapters} from '../lib/agent-features/services.js';
import {runFeature} from '../lib/toolbox/core.js';
import {journal} from '../lib/toolbox/journal.js';
const id=(s:string)=>s.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0];
const state=async(f:ReturnType<typeof createAgentFeatureFixture>):Promise<any>=>f.store().read('state');
const owner={teamId:'TENERGY',userId:'UENERGY'},now=new Date('2026-10-22T15:00:00Z');
function production(backend=createMemoryAgentBackend()) {
 const services=createAgentFeatureServices(backend,owner,new AbortController().signal,{now,timezone:'America/Chicago',featureId:feature.id},createProductionContextAdapters({redis:async()=>{throw new Error('Unexpected legacy read');},evaluateAccess:async()=>{throw new Error('Unexpected policy read');}}));
 const f=createAgentFeatureFixture(feature,{backend,owner,now,services});return {f,services,key:`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:journal`};
}
const esc=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\|/g,'\\|');
test('literal 1–5 measurements, independent median/range oracle, sparse bands and activity comparisons',async()=>{
 const f=createAgentFeatureFixture(feature);
 const a=id(await f.run('checkin 2026-10-22 | morning | 4 | writing | Felt alert'));
 await f.run('checkin 2026-10-22 | afternoon | 2 | admin | Needed a shorter task');
 let out=await f.run('patterns 2026-10-01 | 2026-10-31');assert.match(out,/morning: sparse data: 1/);assert.doesNotMatch(out,/median/);
 for(const [d,e] of [['01',1],['10',5],['18',2]])await f.run(`checkin 2026-10-${d} | morning | ${e} | writing | Note`);
 out=await f.run('patterns 2026-10-01 | 2026-10-31');assert.match(out,/morning: n=4; median 3; range 1–5; sample dates 2026-10-01, 2026-10-10, 2026-10-18, 2026-10-22/);assert.match(out,/Activity writing: n=4; median 3/);assert.match(out,/afternoon: sparse/);assert.match(out,/evening: sparse data: 0/);
 await f.run(`clear ${a} energy confirm`);assert.match(await f.run('patterns 2026-10-01 | 2026-10-31'),/morning: n=3; median 2/);
 await f.run(`edit ${a} | 2026-10-22 | evening | 5 | reading | Revised`);await f.run(`note ${a} | A long meeting preceded this check-in`);
 assert.equal((await state(f)).records[0].note,'A long meeting preceded this check-in');assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test('real toolbox → production adapter/services → runtime: explicit journal selection, literal date/provenance, change and deletion',async()=>{
 const {f,services,key}=production();await runFeature(journal,'write 2026-10-22 | 5 | Shipped a feature | Start smaller next time',owner,undefined,f.backend,now);
 const checkin=id(await f.run('checkin 2026-10-22 | morning | 2 | writing | Low energy'));
 const source=(await services.readContext(['journal']))[0];
 const listing=await f.run('journals 2026-10-22'),fingerprint=listing.match(/e1:[0-9a-f]{64}/)![0];assert.match(listing,/literal day 2026-10-22/);
 const detail=await f.run('journal '+source.id);assert.match(detail,/"mood": 5/);
 let out=await f.run(`attach ${checkin} | ${source.id} | ${fingerprint} | Shipped a feature`);assert.match(out,/Saved privately/);
 const a=(await state(f)).records[0];assert.equal(a.energy,2);assert.equal(a.sources[0].evidence.sources[0].metadata.day,'2026-10-22');assert.equal(a.sources[0].evidence.sources[0].metadata.source,'Personal toolbox / journal');assert.equal(a.sources[0].evidence.sources[0].text,'Shipped a feature');assert.equal(f.calls.readContext,3);
 const before=f.backend.data.get(key);await f.run(`note ${checkin} | Context only`);assert.equal(f.backend.data.get(key),before);
 await runFeature(journal,'write 2026-10-22 | 1 | Updated entry | New lesson',owner,undefined,f.backend,now);
 const saved=await state(f);out=await f.run(`attach ${checkin} | ${source.id} | ${fingerprint} | Shipped a feature`);assert.match(out,/changed/);assert.deepEqual(await state(f),saved);
 f.backend.data.set(key,JSON.stringify({entries:[]}));assert.match(await f.run(`attach ${checkin} | ${source.id} | ${fingerprint} | Shipped a feature`),/absent/);assert.deepEqual(await state(f),saved);
 assert.match(await f.run(`detach ${checkin} ${a.sources[0].id} confirm`),/Saved privately/);
});
test('deferred journal reads cannot resurrect deleted check-ins; cancellation stops late attachment; CAS same-record conflict wins',async()=>{
 const {f,services}=production();await runFeature(journal,'write 2026-10-22 | 4 | Win | Lesson',owner,undefined,f.backend,now);
 const raw=await services.readContext(['journal']);const original=f.services.readContext;
 const listing=await f.run('journals 2026-10-22'),fp=listing.match(/e1:[0-9a-f]{64}/)![0];
 const a=id(await f.run('checkin 2026-10-22 | morning | 4 | Work | Note'));
 let enter=deferred<void>(),read=deferred<typeof raw>();f.services.readContext=async()=>{enter.resolve();return read.promise;};
 const pending=f.run(`attach ${a} | ${raw[0].id} | ${fp} | Win`);await enter.promise;await f.run(`delete ${a} confirm`);read.resolve(raw);assert.match(await pending,/not found/);assert.equal((await state(f)).records.length,0);
 f.services.readContext=original;const b=id(await f.run('checkin 2026-10-22 | morning | 4 | Work | Note'));
 enter=deferred();read=deferred();f.services.readContext=async()=>{enter.resolve();return read.promise;};const ac=new AbortController();const abort=f.run(`attach ${b} | ${raw[0].id} | ${fp} | Win`,{signal:ac.signal});await enter.promise;ac.abort();await assert.rejects(abort);read.resolve(raw);await new Promise(resolve=>setImmediate(resolve));assert.equal((await state(f)).records[0].sources.length,0);
 f.services.readContext=original;const underlying=f.backend.compareSet;let fired=false;
 f.backend.compareSet=async(k,p,n,t)=>{if(!fired){fired=true;const current=JSON.parse(p!);current.records[0].note='Later note';current.records[0].revision++;f.backend.data.set(k,JSON.stringify(current));}return underlying(k,p,n,t);};
 assert.match(await f.run(`note ${b} | Older note`),/changed/);assert.equal((await state(f)).records[0].note,'Later note');
});
test('strict persisted enums/source evidence, missing/invalid journal data and complete 100-item discovery',async()=>{
 const {f,key}=production();const a=id(await f.run('checkin 2026-10-22 | morning | 4 | Work | Note'));const good=await state(f);
 for(const field of ['band','energy','date']){const s=structuredClone(good);s.records[0][field]=field==='band'?['morning']:field==='energy'?'4':'2026-02-30';const raw=JSON.stringify(s);f.backend.data.set(f.key('state'),raw);assert.match(await f.run(`delete ${a} confirm`),/Invalid/);assert.equal(f.backend.data.get(f.key('state')),raw);}
 f.backend.data.set(f.key('state'),JSON.stringify(good));f.backend.data.set(key,JSON.stringify({entries:[{id:'bad',title:'Bad',body:'Text',data:{day:'2026-02-30',mood:2}}]}));assert.match(await f.run('journals 2026-10-22'),/could not be read/);assert.deepEqual(await state(f),good);
 const entries=Array.from({length:100},(_,i)=>({id:'j'+i,title:'Journal '+i,body:'Text '+i,data:{day:'2026-10-22',mood:1},updatedAt:now.toISOString(),createdAt:now.toISOString()}));f.backend.data.set(key,JSON.stringify({entries}));
 let out=await f.run('journals 2026-10-22'),joined='',pages=0;
 for(;;){assert.ok(out.length<=3500);joined+=out;const next=out.match(/\nNext: (.+)$/)?.[1];pages++;if(!next)break;out=await f.run(next.replace('/nobo-help agent energy-patterns ',''));assert.ok(pages<30);}
 for(const e of entries)assert.ok(joined.includes('toolbox:journal:'+e.id+'\n'));assert.ok(pages>1);
 const first=await f.run('journals 2026-10-22'),next=first.match(/\nNext: (.+)$/)![1];entries[0].body='Changed';f.backend.data.set(key,JSON.stringify({entries}));assert.match(await f.run(next.replace('/nobo-help agent energy-patterns ','')),/changed/);
});
test('capacity is visible; max escaped/Unicode report continuations and complete exports remain retrievable',async()=>{
 const f=createAgentFeatureFixture(feature);for(let i=0;i<90;i++){const out=await f.run(`checkin 2026-10-22 | morning | ${i%5+1} | ${esc('漢😀\\|'.repeat(7))} | ${esc('\\'.repeat(240))}`);if(!out.includes('Saved privately'))break;}
 const s=await state(f);assert.ok(s.records.length>20&&s.records.length<90);
 for(const r of s.records){const exported=await f.run('export '+r.id);assert.deepEqual(JSON.parse(exported).record,r);assert.ok(Buffer.byteLength(exported)<=24576);assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);}
 assert.equal((await state(f)).records.length,0);
});
test('all ten selected excerpt slots reserve later replacements after content saturation',async()=>{
 const {f,key}=production();const entries=Array.from({length:11},(_,i)=>({id:'reserve'+i,title:'Journal '+i,body:'\\'.repeat(400),data:{day:`2026-10-${String(i+1).padStart(2,'0')}`,mood:3},createdAt:now.toISOString(),updatedAt:now.toISOString()}));f.backend.data.set(key,JSON.stringify({entries}));
 const selected:{checkin:string;source:string;fingerprint:string}[]=[];
 for(let i=0;i<10;i++){
  const checkin=i%2===0?id(await f.run('checkin 2026-10-22 | morning | 3 | writing | Context')):selected[i-1].checkin;
  const fingerprint=(await f.run('journals '+entries[i].data.day)).match(/e1:[0-9a-f]{64}/)![0],source='toolbox:journal:'+entries[i].id;
  assert.match(await f.run(`attach ${checkin} | ${source} | ${fingerprint} | ${esc('\\')}`),/Saved privately/);selected.push({checkin,source,fingerprint});
 }
 const fp=(await f.run('journals '+entries[10].data.day)).match(/e1:[0-9a-f]{64}/)![0],before=await state(f);
 assert.match(await f.run(`attach ${selected[0].checkin} | toolbox:journal:reserve10 | ${fp} | ${esc('\\')}`),/limit/);assert.deepEqual(await state(f),before);
 for(let i=0;i<90;i++){if(!(await f.run(`checkin 2026-10-22 | evening | 2 | reading | ${esc('\\'.repeat(240))}`)).includes('Saved privately'))break;}
 for(const a of selected)assert.match(await f.run(`attach ${a.checkin} | ${a.source} | ${a.fingerprint} | ${esc('\\'.repeat(400))}`),/Saved privately/);
 const filled=await state(f);assert.equal(filled.records.flatMap((r:any)=>r.sources).length,10);assert.ok(Buffer.byteLength(JSON.stringify(filled))<=49152);
 const record=filled.records[0];let out=await f.run('show '+record.id),body='';for(let i=0;i<20;i++){assert.ok(out.length<=3500);body+=out.split('\n').slice(2).join('\n').replace(/\nNext: .+$/,'');const next=out.match(/\nNext: (.+)$/)?.[1];if(!next)break;out=await f.run(next.replace('/nobo-help agent energy-patterns ',''));}
 assert.deepEqual(JSON.parse(body).record,record);for(const r of filled.records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});
