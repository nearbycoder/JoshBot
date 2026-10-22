import assert from 'node:assert/strict';
import test from 'node:test';
import feature from '../lib/agent-features/interruption-audit.js';
import {createAgentFeatureFixture, createMemoryAgentBackend, deferred} from './helpers/agent-feature-fixture.js';
const id = (s: string) => s.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0];
const state = async (f: ReturnType<typeof createAgentFeatureFixture>): Promise<any> => f.store().read('state');
test('catalog arithmetic, unknown/zero, medians, editable rules, range persistence and full lifecycle',async()=>{
 const f=createAgentFeatureFixture(feature);
 const a=id(await f.run('log 2026-10-22 | chat | Writing guide | 3 | 8 | estimated'));
 const b=id(await f.run('log 2026-10-22 | context switch | Writing guide | 5 | 4 | measured'));
 let out=await f.run('review 2026-10-19 | 2026-10-25');
 assert.match(out,/20 total reported minutes/);assert.match(out,/median complete-entry total 10 minutes \(n=2\)/);
 assert.match(out,/measured: 1 entries; 9 total/);assert.match(out,/estimated: 1 entries; 11 total/);
 await f.run('log 2026-10-22 | chat | Work | 0 | unknown | measured');
 out=await f.run('review 2026-10-19 | 2026-10-25');assert.match(out,/20 total/);assert.match(out,/1 unknown recovery/);
 const rule=id(await f.run('rule chat | Check messages at the end of a writing block'));
 assert.match(await f.run('edit '+rule+' | chat | Put phone away'),/Saved privately/);
 assert.match(await f.run('review 2026-10-19 | 2026-10-25'),/Put phone away/);
 assert.match(await f.run(`measure ${a} | 0 | 0 | measured`),/Saved privately/);
 assert.match(await f.run(`clear ${b} date confirm`),/Saved privately/);
 out=await f.run('review 2026-10-19 | 2026-10-25');assert.match(out,/0 total reported/);assert.match(out,/1 undated/);
 for(const r of (await state(f)).records){assert.ok(JSON.parse(await f.run(`export ${r.id}`)).record);await f.run(`delete ${r.id} confirm`);}
 assert.equal((await state(f)).records.length,0);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test('strict schemas and input reject coercions, invalid civil dates and destructive corrupt-state writes',async()=>{
 const f=createAgentFeatureFixture(feature);const a=id(await f.run('log 2026-10-22 | chat | Work | 0 | unknown | measured'));
 for(const input of ['log 2026-02-30 | chat | Work | 1 | 2 | measured','log 2026-10-22 | chat | Work | 01 | 2 | measured','log 2026-10-22 | chat | Work | 1 | 2 | MEASURED']) {
  const before=f.backend.data.get(f.key('state'));await f.run(input);assert.equal(f.backend.data.get(f.key('state')),before);
 }
 const good=await state(f);
 for(const mutate of [(s:any)=>s.version=2,(s:any)=>s.records[0].basis=['measured'],(s:any)=>s.records[0].recovery='0',(s:any)=>s.records[0].extra=true,(s:any)=>s.records.push({...s.records[0]})]) {
  const bad=structuredClone(good);mutate(bad);const raw=JSON.stringify(bad);f.backend.data.set(f.key('state'),raw);
  assert.match(await f.run(`delete ${a} confirm`),/Invalid|unsupported/);assert.equal(f.backend.data.get(f.key('state')),raw);
 }
});
test('real CAS retries preserve unrelated edits; same-record late deletion and revision ceiling changes win',async()=>{
 let gate=false;const entered=deferred<void>(),release=deferred<void>();
 const backend=createMemoryAgentBackend({beforeCompareSet:async()=>{if(gate){gate=false;entered.resolve();await release.promise;}}});
 const f=createAgentFeatureFixture(feature,{backend});const a=id(await f.run('log 2026-10-22 | chat | A | 1 | 1 | measured'));
 const b=id(await f.run('log 2026-10-22 | chat | B | 2 | 2 | estimated'));
 gate=true;const slow=f.run(`measure ${a} | 3 | 3 | estimated`);await entered.promise;
 await f.run(`measure ${b} | 4 | 4 | measured`);release.resolve();assert.match(await slow,/Saved privately/);
 assert.equal((await state(f)).records.find((r:any)=>r.id===b).recovery,4);assert.equal(backend.calls.conflicts,1);
 const s=await state(f);s.records[0].revision=Number.MAX_SAFE_INTEGER;backend.data.set(f.key('state'),JSON.stringify(s));
 let fired=false;const original=backend.compareSet;backend.compareSet=async(k,p,n,t)=>{
  if(!fired){fired=true;const current=JSON.parse(p!);current.records[0].task='Later work';backend.data.set(k,JSON.stringify(current));}
  return original(k,p,n,t);
 };
 assert.match(await f.run(`delete ${a} confirm`),/changed/);assert.equal((await state(f)).records[0].task,'Later work');
});
test('maximum escaped Unicode records, ten-row lists and exact stamped report continuations',async()=>{
 const f=createAgentFeatureFixture(feature);const task='漢😀\\|'.repeat(12);const encoded=task.replace(/\\/g,'\\\\').replace(/\|/g,'\\|');
 for(let i=0;i<60;i++)assert.match(await f.run(`log 2026-10-${String(i%20+1).padStart(2,'0')} | category${i} | ${encoded} | ${i%8} | 2 | measured`),/Saved privately/);
 const all=(await state(f)).records;assert.equal(all.length,60);let listed='';for(let i=1;i<=6;i++)listed+=await f.run('list '+i);for(const r of all)assert.ok(listed.includes(r.id));
 const one=JSON.parse(await f.run('export '+all[0].id));assert.equal(one.record.task,task);
 let output=await f.run('review 2026-10-01 | 2026-10-31'),joined='';let count=0,continuation='';
 do {assert.ok(output.length<=3500);joined+=output.split('\n').slice(1).join('\n').split('\nNext: ')[0];continuation=output.match(/Next: (\/nobo-help agent interruption-audit [^\n]+)/)?.[1]??'';count++;if(continuation)output=await f.run(continuation.replace('/nobo-help agent interruption-audit ',''));}while(continuation&&count<20);
 assert.ok(count>1);for(let i=0;i<60;i++)assert.equal(joined.split('Category category'+i+':').length-1,1);
 const first=await f.run('review 2026-10-01 | 2026-10-31');const next=first.match(/Next: (.+)/)![1];
 await f.run(`measure ${all[0].id} | 9 | 9 | measured`);assert.match(await f.run(next.replace('/nobo-help agent interruption-audit ','')),/changed/);
 const foreign=await f.run('show '+all[0].id,{owner:{teamId:'TOTHER',userId:f.owner.userId}});assert.match(foreign,/not found/);
});
test('saturate content then finish all measurements and remove records above admission safely',async()=>{
 const f=createAgentFeatureFixture(feature);
 for(let i=0;i<80;i++) {const out=await f.run('log 2026-10-22 | '+ 'c'.repeat(80)+' | '+'\\\\'.repeat(240)+' | unknown | unknown | estimated');if(!out.includes('Saved privately'))break;}
 const s=await state(f);assert.ok(s.records.length>20&&s.records.length<80);const saved=s.records.length;
 for(const r of s.records)assert.match(await f.run(`measure ${r.id} | 1440 | 1440 | estimated`),/Saved privately/);
 const final=await state(f);assert.equal(final.records.length,saved);assert.ok(Buffer.byteLength(JSON.stringify(final))<=49152);
 // Valid lifecycle-grown state remains removable even beyond the content threshold.
 final.revision=Number.MAX_SAFE_INTEGER;for(const r of final.records)r.revision=Number.MAX_SAFE_INTEGER;
 f.backend.data.set(f.key('state'),JSON.stringify(final));
 for(const r of final.records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});
