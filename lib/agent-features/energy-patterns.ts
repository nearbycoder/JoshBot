import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';
import {assertQuota, assertStateVersion, serializedBytes} from './feature-kit/bounded-state.js';
import {civilDate, normalizeInstant} from './feature-kit/civil-time.js';
import {boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart} from './feature-kit/command-and-display.js';
import {captureEvidence, type EvidenceSnapshot} from './feature-kit/evidence.js';
import {contextCapacityMessage} from './budgets.js';
import type {AgentContextItem} from './types.js';
import metadata from './energy-patterns.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';
const route = '/nobo-help agent energy-patterns';
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
  return body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:calendar|toolbox):[A-Za-z0-9:_-]+|e1:[0-9a-f]{64}|[0-9a-f]{64})/g)
    .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function pages(body: string, command: string, value: {revision: number}, page = 1) {
  return checked(() => pageAt(paginateParts(parts(body), {mode: 'plain', title: `Revision ${value.revision}`,
    command: n => `${route} ${command} page ${n} rev ${value.revision} stamp ${stamp(value)}`}), page).text);
}
const evidenceOptions={kinds:['journal'] as const,maxItems:1,maxBytes:16000,metadataKeys:['day','mood','source','createdAt']};
const fullOptions={...evidenceOptions,maxBytes:65536,metadataKeys:['day','mood','wins','lesson','source','createdAt']};
const hashSchema=v.pipe(v.string(),v.regex(/^e1:[0-9a-f]{64}$/));
const evidenceSchema=v.strictObject({version:v.literal(1),sources:v.pipe(v.array(v.unknown()),v.length(1)),fingerprint:hashSchema});
const attachmentSchema=v.strictObject({id:idSchema,capturedAt:instantSchema,sourceFingerprint:hashSchema,evidence:evidenceSchema});
const recordSchema=v.strictObject({id:idSchema,revision:revSchema,date:v.nullable(daySchema),band:v.nullable(v.picklist(['morning','afternoon','evening'])),
 energy:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(5))),activity:text(80),note:text(240),sources:v.pipe(v.array(attachmentSchema),v.maxLength(10))});
const schema=v.strictObject({version:v.literal(1),revision:revSchema,records:v.pipe(v.array(recordSchema),v.maxLength(90))});
type State=v.InferOutput<typeof schema>;type Checkin=State['records'][number];
const initial:State={version:1,revision:1,records:[]};
const envelope=(record:Checkin)=>({feature:metadata.id,version:1,record});
function validate(raw:unknown):State {
 checked(()=>assertStateVersion(raw,1));const p=v.safeParse(schema,raw);if(!p.success)throw new InputError('Invalid saved energy-patterns schema; data preserved. Ask the operator for scoped recovery.');
 const s=p.output,ids:string[]=[],sources=s.records.flatMap(r=>r.sources);let sourceBytes=0;
 for(const r of s.records){ids.push(r.id,...r.sources.map(x=>x.id));for(const a of r.sources){
  const evidence=checked(()=>captureEvidence(a.evidence.sources,evidenceOptions));if(stamp(evidence)!==stamp(a.evidence))throw new InputError('Invalid saved journal evidence; data preserved.');
  const item=evidence.sources[0];validateJournal(item);checked(()=>boundedText(item.title,{label:'Journal title',maxBytes:1200,maxUnits:300,trim:false,allowEmpty:true}));
  checked(()=>boundedText(item.text,{label:'Journal excerpt',maxBytes:1600,maxUnits:400,trim:false}));sourceBytes+=Buffer.byteLength(item.title)+Buffer.byteLength(item.text);
 }}
 if(new Set(ids).size!==ids.length||sources.length>10||sourceBytes>8000)throw new InputError('Journal selection or ID limit exceeded; data preserved.');return s;
}
function validateJournal(item:AgentContextItem){
 if(item.kind!=='journal'||!/^toolbox:journal:[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(item.id))throw new InputError('Journal source has an invalid owned reference.');
 checked(()=>civilDate(item.metadata?.day));
 if(item.metadata?.mood!==undefined&&(typeof item.metadata.mood!=='number'||!Number.isInteger(item.metadata.mood)||item.metadata.mood<1||item.metadata.mood>5))throw new InputError('Journal mood metadata is invalid; no energy was inferred.');
 if(item.metadata?.source!=='Personal toolbox / journal')throw new InputError('Journal source provenance is unavailable.');
}
const get=(s:State,id:string)=>{const r=s.records.find(x=>x.id===id);if(!r)throw new InputError('Check-in not found. Use list.');return r;};
function future(s:State) {
 // Each already-selected slot can be replaced with the largest title/excerpt and optional metadata.
 return {...s,revision:Number.MAX_SAFE_INTEGER,records:s.records.map(r=>({...r,revision:Number.MAX_SAFE_INTEGER,energy:null,sources:r.sources.map(a=>({...a,
 capturedAt:'9999-12-31T23:59:59.999Z',evidence:{...a.evidence,sources:[{id:'toolbox:journal:'+'x'.repeat(200),kind:'journal',title:'漢'.repeat(300),text:'漢'.repeat(400),updatedAt:'9999-12-31T23:59:59.999Z',metadata:{day:'9999-12-31',mood:5,source:'Personal toolbox / journal',createdAt:'9999-12-31T23:59:59.999Z',coverage:'explicit selected excerpt; not complete journal text',textTruncated:true,titleTruncated:false}}]}}))}))};
}
function admit(s:State,mode:'content'|'lifecycle'|'remove') {
 const projected=future(s),limits={maxRecords:90};checked(()=>assertQuota(s,mode==='content'?{kind:'content',records:s.records.map(envelope),limits,future:{value:projected,records:projected.records.map(r=>({feature:metadata.id,version:1,record:r}))}}:{kind:'lifecycle',records:s.records.map(envelope),limits}));
 if(mode!=='remove')checked(()=>assertQuota(projected,{kind:'lifecycle',records:projected.records.map(r=>({feature:metadata.id,version:1,record:r})),limits}));
 for(const r of s.records)pages(JSON.stringify(envelope(r),null,2),`show ${r.id}`,r);
}
async function journals(ctx:AgentFeatureContext) {
 try {const items=await ctx.services.readContext(['journal']);if(items.length>100)throw new InputError('Journal source exceeds 100 adapter items.');
  const seen=new Set<string>();return items.map(item=>{validateJournal(item);if(seen.has(item.id))throw new InputError('Duplicate journal source IDs.');seen.add(item.id);
   const evidence=captureEvidence([item],fullOptions);return {item:evidence.sources[0],fingerprint:evidence.fingerprint};}).sort((a,b)=>a.item.id.localeCompare(b.item.id));
 }catch(e){ctx.signal?.throwIfAborted();throw new InputError(contextCapacityMessage(e,'Use /nobo-help tools journal list; shorten or explicitly remove source entries there, then retry.')??
  'Owned journal source could not be read completely or validated. Check /nobo-help tools journal list; shorten oversized entries or retry when available. Saved check-ins and excerpts are unchanged.');}
}
function patterns(s:State,start:string,end:string) {
 const eligible=s.records.filter(r=>r.date&&r.date>=start&&r.date<=end&&r.energy!==null&&r.band!==null);
 const describe=(rows:Checkin[])=>{if(rows.length<3)return `sparse data: ${rows.length} samples; need at least 3 before descriptive comparison`;
  const xs=rows.map(r=>r.energy!).sort((a,b)=>a-b),n=xs.length;return `n=${n}; median ${(xs[Math.floor((n-1)/2)]+xs[Math.floor(n/2)])/2}; range ${xs[0]}–${xs[n-1]}; sample dates ${rows.map(r=>r.date).sort().join(', ')}`;};
 let out=`Energy observations ${start} through ${end} (inclusive)\n`;
 for(const band of ['morning','afternoon','evening'])out+=`${band}: ${describe(eligible.filter(r=>r.band===band))}\n`;
 for(const activity of [...new Set(eligible.map(r=>r.activity))].sort())out+=`Activity ${activity||'(unspecified)'}: ${describe(eligible.filter(r=>r.activity===activity))}\n`;
 return out+'Missing days are unobserved, not zero. Journal mood is context only. Descriptive self-reports; no causal, health, sleep or medical claim.\n';
}
function input(input:string) {const [d,b,e,activity,note]=fields(input,[10,9,1,80,240],true);date(d);if(b!=='morning'&&b!=='afternoon'&&b!=='evening')throw new InputError('Band must be morning, afternoon or evening.');return {date:d,band:b as 'morning'|'afternoon'|'evening',energy:num(e,1,5),activity,note};}
async function execute(command:string,ctx:AgentFeatureContext):Promise<string>{
 checked(()=>boundedText(command,{label:'Command',maxBytes:16000}));if(command==='help')return metadata.help;
 const s=validate(await ctx.store.read('state')??initial),newId=randomUUID(),capturedAt=ctx.now.toISOString();
 // Confirmed whole-record deletion has its own recovery path. Retained records
 // are exact copies, so their independent lifecycle projections cannot grow.
 const deleteRoot=(key:string)=>{
  const expected=get(s,key);
  return ctx.store.update('state',initial,raw=>{
   const before=validate(raw);assertSame(get(before,key),expected);
   const next={...before,revision:bump(before.revision,true),records:before.records.filter(r=>r.id!==key)};
   validate(next);
   if(serializedBytes(next)>=serializedBytes(before)||serializedBytes(future(next))>serializedBytes(future(before)))
    throw new InputError('Deletion must reduce saved bytes without growing reserved lifecycle capacity; data preserved.');
   return {value:next,result:`Deleted privately: ${key}\nNext: ${route} list`};
  });
 };
 const save=(change:(next:State)=>Checkin|null,mode:'content'|'lifecycle'|'remove'='content')=>{if(mode!=='remove')writable(s);return ctx.store.update('state',initial,raw=>{const next=validate(raw);if(mode!=='remove')writable(next);const r=change(next);next.revision=bump(next.revision,mode==='remove');validate(next);admit(next,mode);return {value:next,result:r?`Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} show ${r.id}`:'Deleted privately. Use list to inspect remaining check-ins.'};});};
 const edit=(key:string,change:(r:Checkin)=>void,mode:'content'|'lifecycle'|'remove'='content')=>{const expected=get(s,key);if(mode!=='remove')writable(s,expected);return save(next=>{const r=get(next,key);assertSame(r,expected);if(mode!=='remove')writable(next,r);change(r);r.revision=bump(r.revision,mode==='remove');return r;},mode);};
 let m:RegExpMatchArray|null;
 if((m=command.match(/^list(?: (?:page )?(\d+))?$/))){const n=checked(()=>parsePage(m![1])),all=[...s.records].sort((a,b)=>(a.date??'~').localeCompare(b.date??'~')||a.id.localeCompare(b.id));if(n>Math.max(1,Math.ceil(all.length/10)))throw new InputError('Page out of range; restart list.');return `Current list ${n}/${Math.max(1,Math.ceil(all.length/10))}; ${serializedBytes(s)}/49152 bytes\n`+(all.slice((n-1)*10,n*10).map(r=>`${r.id} · ${r.date??'undated'} · ${r.band??'no band'} · ${r.energy??'unknown'} · ${r.activity}`).join('\n')||`No check-ins. Start: ${metadata.example}`)+(n*10<all.length?`\nNext: ${route} list ${n+1}`:'');}
 if((m=command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[1]);guard(r,m[3],m[4]);return pages(JSON.stringify(envelope(r),null,2),`show ${r.id}`,r,checked(()=>parsePage(m![2])));}
 if((m=command.match(/^export (\S+)$/))){const out=envelope(get(s,m[1]));if(serializedBytes(out)>24576)throw new InputError('Export too large; use show pages.');return JSON.stringify(out);}
 if((m=command.match(/^delete (\S+)(?: (confirm))?$/))){const r=get(s,m[1]);if(!m[2])return `Remove check-in and its selected excerpts: ${route} delete ${r.id} confirm`;return deleteRoot(r.id);}
 if(command.startsWith('checkin ')){const value=input(command.slice(8));return save(next=>{const r:Checkin={id:newId,revision:1,...value,sources:[]};next.records.push(r);return r;});}
 if((m=command.match(/^edit (\S+)\s*\|([\s\S]*)$/))){const value=input(m[2]);return edit(m[1],r=>Object.assign(r,value));}
 if((m=command.match(/^note (\S+)\s*\|([\s\S]*)$/))){const [note]=fields(m[2],[240]);return edit(m[1],r=>{r.note=note;});}
 if((m=command.match(/^clear (\S+) (date|band|energy|activity|note) confirm$/))){const field=m[2];return edit(m[1],r=>{if(field==='activity'||field==='note')r[field]='';else r[field as 'date'|'band'|'energy']=null;},'remove');}
 if((m=command.match(/^patterns (\d{4}-\d{2}-\d{2})\s*\|\s*(\d{4}-\d{2}-\d{2})(?: page (\d+) rev (\d+) stamp ([0-9a-f]{64}))?$/))){const start=date(m[1]),end=date(m[2]);if(start>end)throw new InputError('Range end precedes start.');guard(s,m[4],m[5]);return pages(patterns(s,start,end),`patterns ${start} | ${end}`,s,checked(()=>parsePage(m![3])));}
 if((m=command.match(/^journals (\S+)(?: page (\d+) rev (\d+) stamp ([0-9a-f]{64}))?$/))){const day=date(m[1]),items=await journals(ctx),view={revision:s.revision,items:items.map(x=>({id:x.item.id,fingerprint:x.fingerprint}))};guard(view,m[3],m[4]);
  const selected=items.filter(x=>x.item.metadata?.day===day);return pages(`Owned journal context for literal day ${day}; fresh bounded read, ${items.length} available items.\n`+(selected.map(x=>`${x.item.id}\nFingerprint ${x.fingerprint}\n${x.item.title}\nOpen: ${route} journal ${x.item.id}\n`).join('')||'No journal entry for this literal day in the permitted snapshot.\n')+'Context only; mood is never energy. Explicitly attach an exact excerpt (up to 400 JS units) using attach CHECKIN | SOURCE_ID | FINGERPRINT | EXCERPT.\n',`journals ${day}`,view,checked(()=>parsePage(m![2])));}
 if((m=command.match(/^journal (\S+)(?: page (\d+) rev (\d+) stamp ([0-9a-f]{64}))?$/))){const items=await journals(ctx),view={revision:s.revision,items:items.map(x=>({id:x.item.id,fingerprint:x.fingerprint}))};guard(view,m[3],m[4]);const source=items.find(x=>x.item.id===m![1]);if(!source)throw new InputError('Journal source absent from this permitted snapshot; rerun journals.');return pages(JSON.stringify(source,null,2),`journal ${source.item.id}`,view,checked(()=>parsePage(m![2])));}
 if((m=command.match(/^attach (\S+)\s*\|([\s\S]*)$/))){const key=m[1],expected=get(s,key),[sourceId,fingerprint,excerpt]=fields(m[2],[256,67,1600]);checked(()=>boundedText(excerpt,{label:'Excerpt',maxBytes:1600,maxUnits:400,trim:false}));
  writable(s,expected);const items=await journals(ctx),source=items.find(x=>x.item.id===sourceId);if(!source)throw new InputError('Journal source absent from this permitted snapshot; rerun journals.');if(source.fingerprint!==fingerprint)throw new InputError('Journal source changed; rerun journals and select its current fingerprint.');if(!source.item.text.includes(excerpt))throw new InputError('Excerpt must occur exactly in the current journal source text.');
  const item=source.item,evidence=checked(()=>captureEvidence([{id:item.id,kind:'journal',title:item.title,text:excerpt,...(item.updatedAt?{updatedAt:item.updatedAt}:{}),metadata:{day:item.metadata!.day,...(item.metadata!.mood!==undefined?{mood:item.metadata!.mood}:{}),source:'Personal toolbox / journal',...(item.metadata!.createdAt?{createdAt:item.metadata!.createdAt}:{}),coverage:'explicit selected excerpt; not complete journal text',textTruncated:true,titleTruncated:item.metadata?.titleTruncated??false}}],evidenceOptions));
  const existing=expected.sources.find(a=>(a.evidence.sources[0] as AgentContextItem).id===sourceId);
  return edit(key,r=>{const attachment={id:existing?.id??newId,capturedAt,sourceFingerprint:fingerprint,evidence};r.sources=r.sources.filter(a=>(a.evidence.sources[0] as AgentContextItem).id!==sourceId);r.sources.push(attachment);},existing?'lifecycle':'content');}
 if((m=command.match(/^detach (\S+) (\S+) confirm$/))){const attachment=m[2];return edit(m[1],r=>{if(!r.sources.some(a=>a.id===attachment))throw new InputError('Selected excerpt not found.');r.sources=r.sources.filter(a=>a.id!==attachment);},'remove');}
 throw new InputError(`Unknown or incomplete command. Use ${route} help`);
}
export default {...metadata,async execute(command:string,ctx:AgentFeatureContext){try{return await execute(command,ctx);}catch(e){ctx.signal?.throwIfAborted();return e instanceof InputError?`${e.message}\nNext: ${route} help`:`Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed.\nNext: ${route} list`;}}} satisfies AgentFeature;
