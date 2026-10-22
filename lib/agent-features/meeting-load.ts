import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';
import {assertQuota, assertStateVersion, serializedBytes} from './feature-kit/bounded-state.js';
import {civilDate, normalizeInstant, civilDaysBetween, addCivilDays, dateInZone} from './feature-kit/civil-time.js';
import {boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart} from './feature-kit/command-and-display.js';
import {captureEvidence, type EvidenceSnapshot} from './feature-kit/evidence.js';
import {contextCapacityMessage} from './budgets.js';
import type {AgentContextItem} from './types.js';
import {ZonedTime, minuteOfDay, validDate} from './day-planner/time.js';
import {timezone} from './calendar/time.js';
import metadata from './meeting-load.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';
const route = '/nobo-help agent meeting-load';
class InputError extends Error {}
function checked<T>(f: () => T): T {
  try { return f(); } catch (e) { throw new InputError(e instanceof Error ? e.message : 'Invalid input.'); }
}
const text = (bytes: number, units = bytes) => v.pipe(v.string(), v.check(s => {
  try { boundedText(s, {label: 'Text', maxBytes: bytes, maxUnits: units, trim: false, allowEmpty: true}); return true; } catch { return false; }
}));
const idSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const revSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const instantSchema = v.pipe(v.string(), v.check(s => { try { return normalizeInstant(s) === s; } catch { return false; } }));
const daySchema = v.pipe(v.string(), v.check(s => { try { civilDate(s); return true; } catch { return false; } }));
function bump(n: number, removal = false) {
  if (n === Number.MAX_SAFE_INTEGER && !removal)
    throw new InputError('Revision limit reached. Export saved records before explicit field removal or delete ID confirm. This finite limit cannot be retried or reset.');
  return Math.min(Number.MAX_SAFE_INTEGER, n + 1);
}
function writable(state: {revision: number}, record?: {revision: number}) {
  bump(state.revision);
  if (record) bump(record.revision);
}
const stamp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (input: string, limits: number[], empty = false) => checked(() => pipeFields(input,
  limits.map(maxBytes => ({label: 'Field', maxBytes: maxBytes + 32, allowEmpty: empty})))
  .map((x, i) => boundedText(x, {label: 'Field', maxBytes: limits[i], trim: false, allowEmpty: empty})));
const date = (s: string) => checked(() => civilDate(s));
const num = (s: string, min: number, max: number) => checked(() => parseInteger(s, {min, max}));
function guard(value: {revision: number}, expected?: string, digest?: string) {
  if (expected !== undefined && (value.revision !== num(expected, 1, Number.MAX_SAFE_INTEGER) || digest !== stamp(value)))
    throw new InputError('Saved content changed; restart this view or command.');
}
function assertSame(actual: unknown, expected: unknown) {
  if (stamp(actual) !== stamp(expected)) throw new InputError('Saved content changed; reopen it before retrying.');
}
function parts(body: string): DisplayPart[] {
  return body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:calendar|toolbox):[A-Za-z0-9:_-]+|e1:[0-9a-f]{64}|[0-9a-f]{64}|[0-9a-f]{24})/g)
    .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function pages(body: string, command: string, value: {revision: number}, page = 1) {
  return checked(() => pageAt(paginateParts(parts(body), {mode: 'plain', title: `Revision ${value.revision}`,
    command: n => `${route} ${command} page ${n} rev ${value.revision} stamp ${stamp(value)}`}), page).text);
}
const evidenceOptions={kinds:['event'] as const,maxItems:100,maxBytes:196608,metadataKeys:['source','calendarEventId','startAt','endAt','allDay','busy','timezone','startDate','endDate']};
const fullOptions={...evidenceOptions,maxItems:1,maxBytes:65536,metadataKeys:[...evidenceOptions.metadataKeys,'uid','location']};
const zoneSchema=v.pipe(v.string(),v.maxLength(100),v.check(s=>{try{timezone(s);return true;}catch{return false;}}));
const clockSchema=v.pipe(v.string(),v.check(s=>minuteOfDay(s,true)!==null));
const workSchema=v.strictObject({start:clockSchema,end:clockSchema,focus:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(1440)),recovery:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(1440))});
const rangeSchema=v.strictObject({start:daySchema,end:daySchema});
const configSchema=v.strictObject({range:v.nullable(rangeSchema),work:v.nullable(workSchema),labelBytes:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(80))});
const millis=v.pipe(v.number(),v.integer(),v.check(n=>Number.isSafeInteger(n)&&Number.isFinite(new Date(n).getTime())&&new Date(n).toISOString().length===24));
// Compact columns are documented/exported; all 100 intervals survive, including points and transparent events.
// Check the stored arity before tuple parsing can discard unknown columns.
const eventSchema=v.pipe(v.unknown(),v.check(input=>Array.isArray(input)&&input.length===9),v.strictTuple([v.pipe(v.string(),v.regex(/^[0-9a-f]{24}$/)),millis,millis,v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(7)),v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(99)),text(80),millis,v.nullable(daySchema),v.nullable(daySchema)]));
const snapshotSchema=v.strictObject({capturedAt:instantSchema,captureDay:daySchema,timezone:zoneSchema,config:configSchema,
 coverage:v.picklist(['complete-confirmed-import','empty-unverified']),fingerprint:v.pipe(v.string(),v.regex(/^e1:[0-9a-f]{64}$/)),sourceStamp:v.pipe(v.string(),v.regex(/^[0-9a-f]{64}$/)),
 zones:v.pipe(v.array(zoneSchema),v.maxLength(100)),events:v.pipe(v.array(eventSchema),v.maxLength(100))});
const recordSchema=v.strictObject({id:idSchema,revision:revSchema,title:text(120),config:configSchema,snapshot:v.nullable(snapshotSchema)});
const schema=v.strictObject({version:v.literal(1),revision:revSchema,records:v.pipe(v.array(recordSchema),v.maxLength(8))});
type State=v.InferOutput<typeof schema>;type Review=State['records'][number];type Snapshot=v.InferOutput<typeof snapshotSchema>;type Config=v.InferOutput<typeof configSchema>;type Event=v.InferOutput<typeof eventSchema>;
const initial:State={version:1,revision:1,records:[]};
const defaultWork={start:'09:00',end:'17:00',focus:60,recovery:10};
const envelope=(record:Review)=>({feature:metadata.id,version:1,eventColumns:['calendar ID suffix (prepend calendar:cal_)','start epoch ms','exclusive end epoch ms','flags: busy=1/all-day=2/label-clipped=4','source timezone index','label preview','source updated epoch ms','original all-day start date','original exclusive end date'],record});
function config(c:Config){if(c.range){if(!validDate(c.range.start)||!validDate(c.range.end)||c.range.start>c.range.end||civilDaysBetween(c.range.start,c.range.end)>=14)throw new InputError('Use 1–14 inclusive civil days between 1900 and 2200.');}if(c.work&&(minuteOfDay(c.work.start)===null||minuteOfDay(c.work.start)!>=minuteOfDay(c.work.end,true)!))throw new InputError('Work window must start before its end; only the end may be 24:00.');}
function projectedSource(e:Event,zones:string[]):AgentContextItem {const [suffix,start,end,flags,zone,label,updated,startDate,endDate]=e;const allDay=!!(flags&2),busy=!!(flags&1);return {id:`calendar:cal_${suffix}`,kind:'event',title:label,text:'',updatedAt:new Date(updated).toISOString(),dueAt:new Date(start).toISOString(),status:busy?'busy':'free',metadata:{source:'calendar',calendarEventId:`cal_${suffix}`,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),allDay,busy,timezone:zones[zone],...(allDay?{startDate,endDate}:{}),coverage:'complete interval; label preview; source body omitted',titleTruncated:!!(flags&4),textTruncated:true}};}
function validate(raw:unknown):State {
 checked(()=>assertStateVersion(raw,1));const p=v.safeParse(schema,raw);if(!p.success)throw new InputError('Invalid saved meeting-load schema; data preserved. Ask the operator for scoped recovery.');const s=p.output;
 if(new Set(s.records.map(r=>r.id)).size!==s.records.length)throw new InputError('Duplicate saved report IDs; data preserved.');
 for(const r of s.records){config(r.config);if(!r.snapshot)continue;const snap=r.snapshot;config(snap.config);if(!snap.config.range||!snap.config.work||snap.captureDay!==dateInZone(new Date(snap.capturedAt),snap.timezone)||snap.coverage!==(snap.events.length?'complete-confirmed-import':'empty-unverified')||new Set(snap.events.map(e=>e[0])).size!==snap.events.length||new Set(snap.zones).size!==snap.zones.length)throw new InputError('Invalid saved report coverage or configuration; data preserved.');
  let bytes=0;const used=new Set<number>(),tz=new ZonedTime(snap.timezone);
  for(const e of snap.events){const [,start,end,flags,z,label,,from,to]=e;bytes+=Buffer.byteLength(label);used.add(z);if(z>=snap.zones.length||start>end||Buffer.byteLength(label)>snap.config.labelBytes)throw new InputError('Invalid saved interval or label; data preserved.');
   if(flags&2){if(!from||!to||from>=to||checked(()=>tz.local(from,'00:00'))!==start||checked(()=>tz.local(to,'00:00'))!==end||snap.zones[z]!==snap.timezone)throw new InputError('Invalid saved all-day civil interval; data preserved.');}else if(from!==null||to!==null)throw new InputError('Timed events cannot contain all-day civil dates.');
  }
  if(bytes>8000||used.size!==snap.zones.length||serializedBytes(snap)>22000)throw new InputError('Invalid saved snapshot capacity; data preserved.');
  const evidence=checked(()=>captureEvidence(snap.events.map(e=>projectedSource(e,snap.zones)),evidenceOptions));if(evidence.fingerprint!==snap.fingerprint)throw new InputError('Invalid saved calendar fingerprint; data preserved.');
 }
 return s;
}
const get=(s:State,id:string)=>{const r=s.records.find(x=>x.id===id);if(!r)throw new InputError('Report not found. Use list.');return r;};
function future(s:State){return {...s,revision:Number.MAX_SAFE_INTEGER,records:s.records.map(r=>({...r,revision:Number.MAX_SAFE_INTEGER,
 config:{range:{start:'9999-12-01',end:'9999-12-14'},work:{start:'00:00',end:'24:00',focus:1440,recovery:1440},labelBytes:80},
 // Exactly 22000 serialized bytes reserves any admitted snapshot replacement, regardless of event mix.
 snapshot:r.snapshot?'x'.repeat(21998):null}))};}
function admit(s:State,mode:'content'|'lifecycle'|'remove'){const projected=future(s),limits={maxRecords:8},futureRecords=projected.records.map(record=>({...envelope(s.records.find(r=>r.id===record.id)!),record}));checked(()=>assertQuota(s,mode==='content'?{kind:'content',records:s.records.map(envelope),limits,future:{value:projected,records:futureRecords}}:{kind:'lifecycle',records:s.records.map(envelope),limits}));if(mode!=='remove')checked(()=>assertQuota(projected,{kind:'lifecycle',records:futureRecords,limits}));for(const r of s.records)pages(JSON.stringify(envelope(r),null,2),`show ${r.id}`,r);}
function clipLabel(s:string,limit:number){let out='',bytes=0;for(const ch of s){const n=Buffer.byteLength(ch);if(bytes+n>limit)break;out+=ch;bytes+=n;}return out;}
async function capture(ctx:AgentFeatureContext,c:Config):Promise<Snapshot>{
 const zone=checked(()=>timezone(ctx.timezone));
 try {const items=await ctx.services.readContext(['event']);if(items.length>100)throw new InputError('Calendar has more than 100 adapter events.');
  const events:Event[]=[],zones:string[]=[],seen=new Set<string>(),fingerprints:{id:string;fingerprint:string}[]=[];const zoned=new ZonedTime(zone);
  for(const raw of items){const full=captureEvidence([raw],fullOptions),item=full.sources[0],m=item.metadata;
   if(!/^calendar:cal_[0-9a-f]{24}$/.test(item.id)||seen.has(item.id)||m?.source!=='calendar'||m.calendarEventId!==item.id.slice(9)||typeof m.busy!=='boolean'||typeof m.allDay!=='boolean'||typeof m.timezone!=='string'||m.coverage!==undefined&&m.coverage!=='complete-confirmed-import')throw new InputError('Calendar snapshot has unresolved identity, interval coverage or flags.');
   seen.add(item.id);timezone(m.timezone);const start=normalizeInstant(m.startAt),end=normalizeInstant(m.endAt),updated=normalizeInstant(item.updatedAt);
   if(start>end||item.dueAt!==start||item.status!==(m.busy?'busy':'free'))throw new InputError('Calendar interval endpoints or busy status are inconsistent.');
   let startDate:string|null=null,endDate:string|null=null;
   if(m.allDay){startDate=civilDate(m.startDate);endDate=civilDate(m.endDate);if(startDate>=endDate||zoned.local(startDate,'00:00')!==Date.parse(start)||zoned.local(endDate,'00:00')!==Date.parse(end)||m.timezone!==zone)throw new InputError('All-day interval does not match original civil dates and caller timezone.');}
   else if(m.startDate!==undefined||m.endDate!==undefined)throw new InputError('Timed calendar event contains unresolved all-day dates.');
   const label=clipLabel(item.title,c.labelBytes),z=zones.indexOf(m.timezone);if(z<0)zones.push(m.timezone);
   events.push([item.id.slice('calendar:cal_'.length),Date.parse(start),Date.parse(end),(m.busy?1:0)|(m.allDay?2:0)|(label!==item.title||m.titleTruncated===true?4:0),z<0?zones.length-1:z,label,Date.parse(updated),startDate,endDate]);fingerprints.push({id:item.id,fingerprint:full.fingerprint});
  }
  events.sort((a,b)=>a[0].localeCompare(b[0]));fingerprints.sort((a,b)=>a.id.localeCompare(b.id));
  const evidence=captureEvidence(events.map(e=>projectedSource(e,zones)),evidenceOptions);
  const snapshot:Snapshot={capturedAt:ctx.now.toISOString(),captureDay:dateInZone(ctx.now,zone),timezone:zone,config:structuredClone(c),coverage:events.length?'complete-confirmed-import':'empty-unverified',fingerprint:evidence.fingerprint,sourceStamp:stamp(fingerprints),zones,events};
  if(serializedBytes(snapshot)>22000)throw new InputError('Complete calendar projection exceeds 22000 snapshot bytes. Set labels REPORT | 0, then analyze again; no intervals were dropped.');return snapshot;
 }catch(e){ctx.signal?.throwIfAborted();if(e instanceof InputError)throw e;throw new InputError(contextCapacityMessage(e,'Check /nobo-help agent calendar list; explicitly remove unneeded confirmed events or shorten source labels, then retry.')??'Owned calendar source could not be read completely or validated. Check /nobo-help agent calendar list and its intervals/timezones; correct unresolved sources or retry when available. Last saved report is unchanged.');}
}
type Interval={start:number;end:number};
function statistics(snap:Snapshot,recovery:number) {
 const work=snap.config.work!,range=snap.config.range!,zone=new ZonedTime(snap.timezone),days=[];
 for(let i=0;i<=civilDaysBetween(range.start,range.end);i++){
  const day=addCivilDays(range.start,i),start=checked(()=>zone.local(day,work.start)),end=checked(()=>zone.local(day,work.end));
  const intervals=snap.events.filter(e=>(e[3]&1)&&e[2]>e[1]).map(e=>({start:Math.max(start,e[1]),end:Math.min(end,e[2])})).filter(e=>e.end>e.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  const union:Interval[]=[];for(const x of intervals){const last=union.at(-1);if(last&&x.start<=last.end)last.end=Math.max(last.end,x.end);else union.push({...x});}
  const gaps:Interval[]=[];let cursor=start;for(const b of union){if(b.start>cursor)gaps.push({start:cursor,end:b.start});cursor=b.end;}if(cursor<end)gaps.push({start:cursor,end});
  const boundaries=[...new Set(intervals.map(e=>e.end))].sort((a,b)=>a-b),buffers=boundaries.map(at=>{const ongoing=intervals.some(e=>e.start<=at&&e.end>at),next=intervals.find(e=>e.start>=at);const available=ongoing?0:((next?.start??end)-at)/60000;return {at,available,deficit:Math.max(0,recovery-available)};});
  days.push({day,start,end,busy:union.reduce((n,e)=>n+(e.end-e.start)/60000,0),gaps,focus:gaps.filter(g=>(g.end-g.start)/60000>=work.focus),buffers,
   touching:boundaries.filter(at=>at<end&&intervals.some(e=>e.start===at)).length});
 }
 return days;
}
function report(r:Review,currentZone:string,recovery?:number){if(!r.snapshot)throw new InputError('No saved snapshot. Configure the report, then analyze.');const snap=r.snapshot,target=recovery??snap.config.work!.recovery,rows=statistics(snap,target);
 let out=`Meeting load: ${r.title}\nCaptured ${snap.capturedAt}; civil capture day ${snap.captureDay}; timezone ${snap.timezone}.\nCoverage: ${snap.events.length?`all ${snap.events.length} confirmed events returned by the owned calendar adapter; complete imported set only`:'empty/unverified imported snapshot; real-calendar availability unknown'}. External calendar completeness is unknown.\nCurrent configuration: ${JSON.stringify(r.config)}; caller timezone ${currentZone}.\nSaved analysis assumptions: ${JSON.stringify(snap.config)}; timezone ${snap.timezone}.\n`;
 if(stamp(r.config)!==stamp(snap.config)||currentZone!==snap.timezone)out+='STALE configuration/timezone: report and what-if use the captured assumptions. Analyze again to refresh.\n';
 if(recovery!==undefined)out+=`What-if recovery ${target} minutes (saved target ${snap.config.work!.recovery}); no source reread.\n`;
 out+='Busy minutes union clipped half-open intervals; points/transparent events contribute no duration. Recovery is free time after each distinct clipped busy end, bounded by the next busy start or work-window end (overlap gives zero).\n';
 out+=`Total busy ${rows.reduce((n,d)=>n+d.busy,0)} minutes; recovery deficits ${rows.reduce((n,d)=>n+d.buffers.reduce((t,b)=>t+b.deficit,0),0)} minutes; ${rows.reduce((n,d)=>n+d.focus.length,0)} focus-qualified gaps.\n`;
 for(const d of rows){out+=`${d.day}: work ${(d.end-d.start)/60000} elapsed minutes; busy ${d.busy}; uninterrupted gaps ${d.gaps.length}; focus gaps ${d.focus.length}; touching boundaries ${d.touching}; ${d.focus.length?'focus target has a qualifying gap':'minimum focus-gap target unmet in this snapshot'}.\n`;
  for(const g of d.gaps)out+=`Gap ${new Date(g.start).toISOString()} → ${new Date(g.end).toISOString()} = ${(g.end-g.start)/60000} minutes\n`;
  for(const b of d.buffers)out+=`Recovery after ${new Date(b.at).toISOString()}: available ${b.available}; deficit ${b.deficit} minutes\n`;
 }
 return out+`Labels are previews (at most ${snap.config.labelBytes} UTF-8 bytes each); all source IDs/intervals/civil dates/timezones are in show/export. No booking or source changes.\n`;
}
function reportPage(r:Review,zone:string,verb:string,n=1,expected?:string,digest?:string,recovery?:number){const view={revision:r.revision,record:r,currentZone:zone};guard(view,expected,digest);return pages(report(r,zone,recovery),verb,view,n);}
async function execute(command:string,ctx:AgentFeatureContext):Promise<string>{
 checked(()=>boundedText(command,{label:'Command',maxBytes:16000}));if(command==='help')return metadata.help;const s=validate(await ctx.store.read('state')??initial),newId=randomUUID();
 const save=(change:(next:State)=>Review|null,mode:'content'|'lifecycle'|'remove'='content',render=false)=>{if(mode!=='remove')writable(s);return ctx.store.update('state',initial,raw=>{const next=validate(raw);if(mode!=='remove')writable(next);const r=change(next);next.revision=bump(next.revision,mode==='remove');validate(next);admit(next,mode);return {value:next,result:r&&render?reportPage(r,ctx.timezone,`report ${r.id}`):r?`Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} ${r.snapshot?'report':'show'} ${r.id}`:'Deleted privately. Use list to inspect remaining configurations.'};});};
 const edit=(key:string,change:(r:Review)=>void,mode:'content'|'lifecycle'|'remove'='content',render=false)=>{const expected=get(s,key);if(mode!=='remove')writable(s,expected);return save(next=>{const r=get(next,key);assertSame(r,expected);if(mode!=='remove')writable(next,r);change(r);r.revision=bump(r.revision,mode==='remove');return r;},mode,render);};let m:RegExpMatchArray|null;
 if((m=command.match(/^list(?: (?:page )?(\d+))?$/))){const n=checked(()=>parsePage(m![1]));if(n!==1)throw new InputError('Only one list page; at most eight configurations.');return `Current list; ${s.records.length}/8 configurations; ${serializedBytes(s)}/49152 bytes\n`+([...s.records].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>`${r.id} · ${r.title||'untitled'} · ${r.snapshot?'captured '+r.snapshot.captureDay:'not analyzed'}`).join('\n')||`No configurations. Start: ${metadata.example}`);}
 if((m=command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[1]);guard(r,m[3],m[4]);return pages(JSON.stringify(envelope(r),null,2),`show ${r.id}`,r,checked(()=>parsePage(m![2])));}
 if((m=command.match(/^report (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[1]);return reportPage(r,ctx.timezone,`report ${r.id}`,checked(()=>parsePage(m![2])),m[3],m[4]);}
 if((m=command.match(/^what-if (\S+) recovery\s*\|\s*(\d+)(?: page (\d+) rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[1]),recovery=num(m[2],0,1440);return reportPage(r,ctx.timezone,`what-if ${r.id} recovery | ${recovery}`,checked(()=>parsePage(m![3])),m[4],m[5],recovery);}
 if((m=command.match(/^export (\S+)$/))){const out=envelope(get(s,m[1]));if(serializedBytes(out)>24576)throw new InputError('Export too large; use show pages.');return JSON.stringify(out);}
 if((m=command.match(/^delete (\S+)(?: (confirm))?$/))){const r=get(s,m[1]);if(!m[2])return `Remove configuration and saved report only: ${route} delete ${r.id} confirm`;return save(next=>{assertSame(get(next,r.id),r);next.records=next.records.filter(x=>x.id!==r.id);return null;},'remove');}
 if(command.startsWith('create ')){const [title,start,end]=fields(command.slice(7),[120,10,10]);date(start);date(end);const c:Config={range:{start,end},work:{...defaultWork},labelBytes:80};config(c);return save(next=>{const r:Review={id:newId,revision:1,title,config:c,snapshot:null};next.records.push(r);return r;});}
 if((m=command.match(/^edit (\S+) title\s*\|([\s\S]*)$/))){const [title]=fields(m[2],[120]);return edit(m[1],r=>{r.title=title;});}
 if((m=command.match(/^range (\S+)\s*\|([\s\S]*)$/))){const [start,end]=fields(m[2],[10,10]).map(date);return edit(m[1],r=>{r.config.range={start,end};},'lifecycle');}
 if((m=command.match(/^settings (\S+)\s*\|([\s\S]*)$/))){const [window,focus,recovery]=fields(m[2],[11,4,4]),times=/^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(window);if(!times)throw new InputError('Work window must be HH:MM-HH:MM.');const work={start:times[1],end:times[2],focus:num(focus,1,1440),recovery:num(recovery,0,1440)};return edit(m[1],r=>{r.config.work=work;},'lifecycle');}
 if((m=command.match(/^labels (\S+)\s*\|([\s\S]*)$/))){const [bytes]=fields(m[2],[2]),value=num(bytes,0,80);return edit(m[1],r=>{r.config.labelBytes=value;},'lifecycle');}
 if((m=command.match(/^clear (\S+) (title|range|settings|snapshot|labels) confirm$/))){const field=m[2];return edit(m[1],r=>{if(field==='title')r.title='';else if(field==='range')r.config.range=null;else if(field==='settings')r.config.work=null;else if(field==='labels')r.config.labelBytes=80;else r.snapshot=null;},'remove');}
 if((m=command.match(/^analyze (\S+)$/))){const key=m[1],expected=get(s,key);writable(s,expected);if(!expected.config.range||!expected.config.work)throw new InputError('Set range and settings before analyzing.');
  // Resolve work boundaries before the one source read; a DST gap/fold cannot imply free time.
  const zone=new ZonedTime(ctx.timezone);for(let i=0;i<=civilDaysBetween(expected.config.range.start,expected.config.range.end);i++){const day=addCivilDays(expected.config.range.start,i);checked(()=>zone.local(day,expected.config.work!.start));checked(()=>zone.local(day,expected.config.work!.end));}
  const snapshot=await capture(ctx,expected.config);return edit(key,r=>{r.snapshot=snapshot;},expected.snapshot?'lifecycle':'content',true);
 }
 throw new InputError(`Unknown or incomplete command. Use ${route} help`);
}
export default {...metadata,async execute(command:string,ctx:AgentFeatureContext){try{return await execute(command,ctx);}catch(e){ctx.signal?.throwIfAborted();return e instanceof InputError?`${e.message}\nNext: ${route} help`:`Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed.\nNext: ${route} list`;}}} satisfies AgentFeature;
