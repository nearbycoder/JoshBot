import assert from 'node:assert/strict';
import test from 'node:test';
import feature from '../lib/agent-features/meeting-load.js';
import calendar from '../lib/agent-features/calendar.js';
import {createAgentFeatureServices,createProductionContextAdapters} from '../lib/agent-features/services.js';
import {createAgentFeatureFixture,createMemoryAgentBackend,deferred} from './helpers/agent-feature-fixture.js';
const owner={teamId:'TLOAD',userId:'ULOAD'},now=new Date('2026-10-22T15:00:00Z');
const id=(s:string)=>s.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0];
const state=async(f:ReturnType<typeof createAgentFeatureFixture>):Promise<any>=>f.store().read('state');
const ics=(events:string[])=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Meeting load fixture//EN',...events,'END:VCALENDAR'].join('\r\n');
const event=(uid:string,fields:string)=>`BEGIN:VEVENT\r\nUID:${uid}\r\n${fields}\r\nEND:VEVENT`;
const timed=(uid:string,start:string,end:string,title='Meeting')=>event(uid,`DTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${title}`);
function fixture(zone='America/Chicago',backend=createMemoryAgentBackend()){
 const services=createAgentFeatureServices(backend,owner,new AbortController().signal,{now,timezone:zone,featureId:feature.id},createProductionContextAdapters({redis:async()=>{throw new Error('Unexpected legacy read');}}));
 const f=createAgentFeatureFixture(feature,{owner,now,timezone:zone,backend,services}),cal=createAgentFeatureFixture(calendar,{owner,now,timezone:zone,backend});return {f,cal,services};
}
async function importEvents(cal:ReturnType<typeof createAgentFeatureFixture>,events:string[]){const preview=await cal.run('import preview '+ics(events)),token=preview.match(/import confirm ([0-9a-f]{32})/)?.[1];assert.ok(token,preview);assert.match(await cal.run('import confirm '+token),/Imported/);}
async function walk(f:ReturnType<typeof createAgentFeatureFixture>,out:string){let body='',firstNext='',count=0;for(;;){assert.ok(out.length<=3500);body+=out.split('\n').slice(2).join('\n').replace(/\nNext: .+$/,'');const next=out.match(/\nNext: (.+)$/)?.[1];if(!next)break;firstNext ||=next;out=await f.run(next.replace('/nobo-help agent meeting-load ',''));assert.ok(++count<40);}return {body,firstNext,count};}
test('real confirmed ICS → production services/adapters → runtime: union, clipping, touch/overlap buffers, point and transparent semantics',async()=>{
 const {f,cal}=fixture();const report=id(await f.run('create Workweek review | 2026-10-26 | 2026-10-26'));
 await f.run(`settings ${report} | 09:00-17:00 | 60 | 10`);
 const source=ics([timed('a','20261026T140000Z','20261026T150000Z'),timed('b','20261026T143000Z','20261026T153000Z'),timed('c','20261026T153000Z','20261026T160000Z'),timed('d','20261026T215000Z','20261026T221000Z'),event('point','DTSTART:20261026T170000Z\r\nSUMMARY:Point'),event('transparent','DTSTART:20261026T160000Z\r\nDTEND:20261026T200000Z\r\nTRANSP:TRANSPARENT\r\nSUMMARY:FYI')]);
 const preview=await cal.run('import preview '+source),token=preview.match(/import confirm ([0-9a-f]{32})/)![1];
 assert.match(await f.run(`analyze ${report}`),/empty\/unverified/);await cal.run('import confirm '+token);
 const reads=f.calls.readContext,out=await f.run(`analyze ${report}`);assert.equal(f.calls.readContext-reads,1);
 assert.match(out,/all 6 confirmed events/);assert.match(out,/Total busy 130 minutes; recovery deficits 30 minutes; 1 focus-qualified gaps/);assert.match(out,/work 480 elapsed minutes; busy 130; uninterrupted gaps 1; focus gaps 1; touching boundaries 1/);assert.match(out,/350 minutes/);
 const captured=await state(f),count=f.calls.readContext;assert.match(await f.run(`what-if ${report} recovery | 15`),/recovery deficits 45 minutes/);assert.equal(f.calls.readContext,count);assert.deepEqual(await state(f),captured);
 await f.run(`settings ${report} | 08:00-16:00 | 45 | 20`);assert.match(await f.run(`report ${report}`),/STALE configuration/);assert.match(await f.run(`what-if ${report} recovery | 0`),/recovery deficits 0 minutes/);
 assert.equal(f.calls.generate,0);assert.equal(f.calls.search,0);
});
test('all-day original civil dates/exclusive end and spring/fall DST elapsed arithmetic; ambiguous/gap windows preserve prior report',async()=>{
 const {f,cal}=fixture();await importEvents(cal,[event('spring','DTSTART;VALUE=DATE:20260308\r\nDTEND;VALUE=DATE:20260309\r\nSUMMARY:All day'),event('fall','DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nSUMMARY:All day')]);
 const key=id(await f.run('create DST | 2026-03-08 | 2026-03-09'));await f.run(`settings ${key} | 00:00-24:00 | 60 | 10`);
 let out=await f.run(`analyze ${key}`);assert.match(out,/2026-03-08: work 1380 elapsed minutes; busy 1380/);assert.match(out,/2026-03-09: work 1440 elapsed minutes; busy 0/);
 let snap=(await state(f)).records[0].snapshot;assert.deepEqual(snap.events.find((e:any)=>e[7]==='2026-03-08').slice(7),['2026-03-08','2026-03-09']);assert.equal(snap.events.length,2);
 await f.run(`range ${key} | 2026-11-01 | 2026-11-01`);out=await f.run(`analyze ${key}`);assert.match(out,/work 1500 elapsed minutes; busy 1500/);
 await f.run(`settings ${key} | 01:30-03:00 | 60 | 10`);let before=await state(f),reads=f.calls.readContext;assert.match(await f.run(`analyze ${key}`),/ambiguous/);assert.equal(f.calls.readContext,reads);assert.deepEqual(await state(f),before);
 await f.run(`range ${key} | 2026-03-08 | 2026-03-08`);await f.run(`settings ${key} | 02:30-04:00 | 60 | 10`);before=await state(f);assert.match(await f.run(`analyze ${key}`),/does not exist/);assert.deepEqual(await state(f),before);
});
test('complete set of100 confirmed events survives compact capture, escaped/Unicode labels, full export and actual stamped continuations',async()=>{
 const {f,cal}=fixture('UTC');const events=Array.from({length:100},(_,i)=>timed('full-'+i,'20261026T090000Z','20261026T100000Z',i%2?'漢😀'.repeat(20):'Labels \\\\ and text '.repeat(5)));
 await importEvents(cal,events);const key=id(await f.run('create Complete | 2026-10-26 | 2026-10-26'));await f.run(`labels ${key} | 60`);
 const out=await f.run(`analyze ${key}`);assert.match(out,/all 100 confirmed events/);assert.match(out,/Total busy 60 minutes/);
 const r=(await state(f)).records[0];assert.equal(r.snapshot.events.length,100);assert.ok(r.snapshot.events.reduce((n:number,e:any)=>n+Buffer.byteLength(e[5]),0)<=8000);assert.ok(r.snapshot.events.some((e:any)=>e[3]&4));
 const exported=await f.run(`export ${key}`);assert.ok(Buffer.byteLength(exported)<=24576);assert.deepEqual(JSON.parse(exported).record,r);
 const detail=await walk(f,await f.run(`show ${key}`));assert.ok(detail.count>1);assert.deepEqual(JSON.parse(detail.body).record,r);
 // 14-day report continuation must reconstruct every day/gap once without changing source revisions.
 await f.run(`range ${key} | 2026-10-19 | 2026-11-01`);const result=await walk(f,await f.run(`analyze ${key}`));assert.ok(result.count>0);for(let i=19;i<=31;i++)assert.equal(result.body.split(`2026-10-${i}: work`).length-1,1);assert.equal(result.body.split('2026-11-01: work').length-1,1);
 await f.run(`labels ${key} | 0`);assert.match(await f.run(result.firstNext.replace('/nobo-help agent meeting-load ','')),/changed/);assert.match(await f.run(`show ${key}`,{owner:{teamId:owner.teamId,userId:'UOTHER'}}),/not found/);
});
test('every source interval validates even transparent/outside range; malformed/partial sources fail visibly with no saved-data loss',async()=>{
 const {f,cal,services}=fixture();await importEvents(cal,[timed('valid','20261026T140000Z','20261026T150000Z')]);const key=id(await f.run('create Valid | 2026-10-26 | 2026-10-26'));await f.run(`analyze ${key}`);const saved=await state(f),raw=await services.readContext(['event']);
 for(const mutate of [(x:any)=>x.metadata.busy=['false'],(x:any)=>x.metadata.endAt='2026-02-30T15:00:00Z',(x:any)=>x.metadata.endAt='2026-10-26T14:00:00',(x:any)=>x.metadata.coverage='partial result',(x:any)=>{x.metadata.allDay=true;x.metadata.startDate='2026-10-26';x.metadata.endDate='2026-10-27';}]){
  const items=structuredClone(raw);mutate(items[0]);f.services.readContext=async()=>items;assert.doesNotMatch(await f.run(`analyze ${key}`),/Total busy/);assert.deepEqual(await state(f),saved);
 }
 f.services.readContext=async()=>Array(101).fill(raw[0]);assert.match(await f.run(`analyze ${key}`),/more than 100/);assert.deepEqual(await state(f),saved);
 for(const mutate of [(s:any)=>s.records[0].snapshot.coverage=['complete-confirmed-import'],(s:any)=>s.records[0].snapshot.events[0][3]='1',(s:any)=>s.records[0].snapshot.events[0][2]--,(s:any)=>s.records[0].config.work.focus='60']){
  const bad=structuredClone(saved);mutate(bad);const encoded=JSON.stringify(bad);f.backend.data.set(f.key('state'),encoded);assert.match(await f.run(`delete ${key} confirm`),/Invalid/);assert.equal(f.backend.data.get(f.key('state')),encoded);
 }
});
test('deferred source reads honor later deletion/cancellation; CAS unrelated edits retry and stale same-record analysis cannot save',async()=>{
 const {f,cal,services}=fixture();await importEvents(cal,[timed('one','20261026T140000Z','20261026T150000Z')]);const raw=await services.readContext(['event']),original=f.services.readContext;
 const a=id(await f.run('create A | 2026-10-26 | 2026-10-26'));
 let enter=deferred<void>(),read=deferred<typeof raw>();f.services.readContext=async()=>{enter.resolve();return read.promise;};
 const stale=f.run(`analyze ${a}`);await enter.promise;await f.run(`delete ${a} confirm`);read.resolve(raw);assert.match(await stale,/not found/);assert.equal((await state(f)).records.length,0);
 f.services.readContext=original;const b=id(await f.run('create B | 2026-10-26 | 2026-10-26'));
 enter=deferred();read=deferred();f.services.readContext=async()=>{enter.resolve();return read.promise;};const ac=new AbortController(),pending=f.run(`analyze ${b}`,{signal:ac.signal});await enter.promise;ac.abort();await assert.rejects(pending);read.resolve(raw);await new Promise(r=>setImmediate(r));assert.equal((await state(f)).records[0].snapshot,null);
 f.services.readContext=original;const c=id(await f.run('create C | 2026-10-26 | 2026-10-26')),cas=f.backend.compareSet;let mode='unrelated';
 f.backend.compareSet=async(k,p,n,t)=>{if(mode){const current=JSON.parse(p!),r=current.records.find((r:any)=>r.id===(mode==='unrelated'?c:b));r.title='Later edit';r.revision=Number.MAX_SAFE_INTEGER;f.backend.data.set(k,JSON.stringify(current));mode='';}return cas(k,p,n,t);};
 assert.match(await f.run(`analyze ${b}`),/Total busy 60/);mode='same';assert.match(await f.run(`analyze ${b}`),/changed/);assert.equal((await state(f)).records.find((r:any)=>r.id===b).title,'Later edit');
});
test('snapshot capacity reserves replacements after admission saturation; fields/removal stay available at revision ceiling',async()=>{
 const {f,cal}=fixture('UTC');await importEvents(cal,Array.from({length:100},(_,i)=>event('capacity-'+i,`DTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261027\r\nSUMMARY:${'\\\\'.repeat(80)}`)));
 const keys:string[]=[];for(let i=0;i<8;i++){const key=id(await f.run(`create Config${i} | 2026-10-26 | 2026-10-26`));await f.run(`labels ${key} | 0`);const out=await f.run(`analyze ${key}`);if(out.includes('Total busy'))keys.push(key);}
 assert.equal(keys.length,2,'byte reservation caps full snapshots before eight configuration count');
 // Growth within the admitted 22000-byte snapshot slot must bypass new-content admission.
 for(const key of keys){await f.run(`labels ${key} | 40`);assert.match(await f.run(`analyze ${key}`),/Total busy/);}
 assert.ok(Buffer.byteLength(JSON.stringify(await state(f)))>32768);
 const current=await state(f);for(const r of current.records)r.revision=Number.MAX_SAFE_INTEGER;f.backend.data.set(f.key('state'),JSON.stringify(current));
 const key=keys[0];for(const field of ['title','range','settings','snapshot','labels'])assert.match(await f.run(`clear ${key} ${field} confirm`),/Saved privately/);
 for(const r of (await state(f)).records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});

test('persisted ICS tuples reject extra or missing columns and unknown own fields before any read or mutation',async()=>{
 const {f,cal}=fixture();await importEvents(cal,[timed('strict','20261026T140000Z','20261026T150000Z')]);
 const key=id(await f.run('create Strict | 2026-10-26 | 2026-10-26'));assert.match(await f.run(`analyze ${key}`),/Total busy 60/);
 const good=await state(f);
 const variants=[
  (s:any)=>s.records[0].snapshot.events[0].push('unrecognized column'),
  (s:any)=>s.records[0].snapshot.events[0].push(null),
  (s:any)=>s.records[0].snapshot.events[0].push({private:'retained'}),
  (s:any)=>s.records[0].snapshot.events[0].pop(),
  (s:any)=>s.records[0].snapshot.events[0].splice(1,1),
  (s:any)=>s.records[0].snapshot.events[0]={...s.records[0].snapshot.events[0],extra:true},
  (s:any)=>s.extra=true,(s:any)=>s.records[0].extra=true,
  (s:any)=>s.records[0].snapshot.extra=true,(s:any)=>s.records[0].snapshot.config.extra=true,
 ];
 for(const mutate of variants){const bad=structuredClone(good);mutate(bad);const raw=' \n'+JSON.stringify(bad)+'\t';f.backend.data.set(f.key('state'),raw);
  const writes=f.backend.calls.writes,reads=f.calls.readContext;
  for(const command of ['list',`show ${key}`,`report ${key}`,`export ${key}`,`edit ${key} title | Valid edit`,`delete ${key} confirm`,`analyze ${key}`]){
   assert.match(await f.run(command),/Invalid saved meeting-load schema/);assert.equal(f.backend.data.get(f.key('state')),raw);assert.equal(f.backend.calls.writes,writes);assert.equal(f.calls.readContext,reads);
  }
 }
});
