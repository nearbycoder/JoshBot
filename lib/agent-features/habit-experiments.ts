import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';
import {assertQuota, assertStateVersion, serializedBytes} from './feature-kit/bounded-state.js';
import {civilDate, normalizeInstant, civilDaysBetween} from './feature-kit/civil-time.js';
import {boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart} from './feature-kit/command-and-display.js';
import {captureEvidence, type EvidenceSnapshot} from './feature-kit/evidence.js';
import {contextCapacityMessage} from './budgets.js';
import type {AgentContextItem} from './types.js';
import metadata from './habit-experiments.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';
const route = '/nobo-help agent habit-experiments';
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
const bump = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n + 1);
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
const evidenceOptions={kinds:['habit'] as const,maxItems:1,maxBytes:16000,metadataKeys:['days','target','source','createdAt','dateBasis']};
const identityOptions={...evidenceOptions,metadataKeys:['target','source','createdAt']};
const hashSchema=v.pipe(v.string(),v.regex(/^e1:[0-9a-f]{64}$/));
const daysSchema=v.nullable(v.pipe(v.array(daySchema),v.maxLength(90)));
const windowsSchema=v.strictObject({baselineStart:daySchema,baselineEnd:daySchema,interventionStart:daySchema,interventionEnd:daySchema});
const opportunitiesSchema=v.strictObject({baseline:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(90))),intervention:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(90)))});
const evidenceSchema=v.strictObject({version:v.literal(1),sources:v.pipe(v.array(v.unknown()),v.length(1)),fingerprint:hashSchema});
const beforeSchema=v.strictObject({capturedAt:instantSchema,sourceFingerprint:hashSchema,baselineDays:daysSchema});
const comparisonSchema=v.strictObject({capturedAt:instantSchema,status:v.picklist(['current','baseline-changed','source-changed','source-absent']),sourceFingerprint:v.nullable(hashSchema),baselineDays:daysSchema,interventionDays:daysSchema});
const recordSchema=v.strictObject({id:idSchema,revision:revSchema,title:text(120),intervention:text(300),windows:v.nullable(windowsSchema),opportunities:v.nullable(opportunitiesSchema),
 source:v.nullable(v.strictObject({capturedAt:instantSchema,identityFingerprint:hashSchema,evidence:evidenceSchema})),before:v.nullable(beforeSchema),comparison:v.nullable(comparisonSchema)});
const schema=v.strictObject({version:v.literal(1),revision:revSchema,records:v.pipe(v.array(recordSchema),v.maxLength(12))});
type State=v.InferOutput<typeof schema>;type Experiment=State['records'][number];type Windows=v.InferOutput<typeof windowsSchema>;
const initial:State={version:1,revision:1,records:[]};
const envelope=(record:Experiment)=>({feature:metadata.id,version:1,record});
function range(w:Windows){for(const [start,end]of[[w.baselineStart,w.baselineEnd],[w.interventionStart,w.interventionEnd]])if(start>end||civilDaysBetween(start,end)>=90)throw new InputError('Each window must be 1–90 inclusive civil days.');if(w.baselineEnd>=w.interventionStart)throw new InputError('Baseline must finish before intervention starts; windows cannot overlap.');}
function validatedDays(value:unknown,max=366):string[]|null {
 if(value===undefined)return null;if(!Array.isArray(value)||value.length>max)throw new InputError('Habit dates must be an explicit bounded array or absent (unknown).');
 const dates=value.map(d=>checked(()=>civilDate(d)));if(new Set(dates).size!==dates.length||dates.some((d,i)=>i>0&&d<=dates[i-1]))throw new InputError('Habit dates must be unique ordered literal civil dates.');return dates;
}
function habit(item:AgentContextItem){
 if(item.kind!=='habit'||!/^toolbox:habits:[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(item.id)||item.metadata?.source!=='Personal toolbox / habits')throw new InputError('Habit source reference/provenance is invalid.');
 validatedDays(item.metadata?.days);const target=item.metadata?.target;if(target!==undefined&&(typeof target!=='number'||!Number.isInteger(target)||target<1||target>7))throw new InputError('Habit weekly target metadata is invalid.');
 if(item.metadata?.days!==undefined&&item.metadata.dateBasis!=='UTC calendar labels (original toolbox dates)')throw new InputError('Habit source date basis is unresolved.');
}
function identity(item:AgentContextItem){return captureEvidence([{id:item.id,kind:'habit',title:item.title,text:'',metadata:Object.fromEntries(['target','source','createdAt'].filter(k=>item.metadata?.[k]!==undefined).map(k=>[k,item.metadata![k]]))}],identityOptions).fingerprint;}
const slice=(days:string[]|null,start:string,end:string)=>days===null?null:days.filter(d=>d>=start&&d<=end);
function denominators(r:Experiment,b:string[]|null,i:string[]|null){
 if(!r.windows||!r.opportunities)return;
 for(const [n,days,start,end]of[[r.opportunities.baseline,b,r.windows.baselineStart,r.windows.baselineEnd],[r.opportunities.intervention,i,r.windows.interventionStart,r.windows.interventionEnd]] as const)
  if(n!==null&&(n>civilDaysBetween(start,end)+1||days!==null&&n<days.length))throw new InputError('Opportunities cannot exceed window days or be below recorded completion counts.');
}
function validate(raw:unknown):State{
 checked(()=>assertStateVersion(raw,1));const p=v.safeParse(schema,raw);if(!p.success)throw new InputError('Invalid saved habit-experiments schema; data preserved. Ask the operator for scoped recovery.');
 const s=p.output;if(new Set(s.records.map(r=>r.id)).size!==s.records.length)throw new InputError('Duplicate saved experiment IDs; data preserved.');
 for(const r of s.records){if(r.windows)range(r.windows);if(r.opportunities&&!r.windows||r.before&&(!r.source||!r.windows)||r.comparison&&(!r.source||!r.windows))throw new InputError('Invalid saved experiment prerequisites; data preserved.');
  if(r.source){const evidence=checked(()=>captureEvidence(r.source!.evidence.sources,evidenceOptions));if(stamp(evidence)!==stamp(r.source.evidence))throw new InputError('Invalid saved habit evidence; data preserved.');const item=evidence.sources[0];habit(item);if(item.text!==''||Buffer.byteLength(item.title)>2000||r.source.identityFingerprint!==identity(item))throw new InputError('Invalid selected habit projection; data preserved.');}
  for(const values of [r.before?.baselineDays,r.comparison?.baselineDays,r.comparison?.interventionDays])if(values!==undefined&&values!==null)validatedDays(values,90);
  if(r.windows){const w=r.windows;if(r.before?.baselineDays?.some(d=>d<w.baselineStart||d>w.baselineEnd)||r.comparison?.baselineDays?.some(d=>d<w.baselineStart||d>w.baselineEnd)||r.comparison?.interventionDays?.some(d=>d<w.interventionStart||d>w.interventionEnd))throw new InputError('Snapshot days outside configured windows; data preserved.');}
  if(r.comparison){const c=r.comparison;if((c.status==='source-absent')!==(c.sourceFingerprint===null)||(c.status==='current'||c.status==='baseline-changed')&&!r.before||['source-absent','source-changed'].includes(c.status)&&(c.baselineDays!==null||c.interventionDays!==null)||c.status==='current'&&stamp(r.before!.baselineDays)!==stamp(c.baselineDays)||c.status==='baseline-changed'&&stamp(r.before!.baselineDays)===stamp(c.baselineDays))throw new InputError('Invalid saved comparison status; data preserved.');}
  denominators(r,r.before?.baselineDays??null,null);
  denominators(r,r.comparison?.baselineDays??null,r.comparison?.interventionDays??null);
 }
 return s;
}
const get=(s:State,id:string)=>{const r=s.records.find(x=>x.id===id);if(!r)throw new InputError('Experiment not found. Use list.');return r;};
function future(s:State){return {...s,revision:Number.MAX_SAFE_INTEGER,records:s.records.map(r=>({...r,revision:Number.MAX_SAFE_INTEGER,windows:{baselineStart:'9999-01-01',baselineEnd:'9999-03-31',interventionStart:'9999-04-01',interventionEnd:'9999-06-29'},opportunities:{baseline:null,intervention:null},
 // Selection is new content. Once selected, reserve 366 date labels plus both 90-day observations.
 source:r.source?{capturedAt:'9999-12-31T23:59:59.999Z',identityFingerprint:'e1:'+'f'.repeat(64),evidence:{version:1,fingerprint:'e1:'+'f'.repeat(64),sources:[{id:'toolbox:habits:'+'x'.repeat(200),kind:'habit',title:'\\'.repeat(2000),text:'',updatedAt:'9999-12-31T23:59:59.999Z',metadata:{days:Array(366).fill('9999-12-31'),target:7,source:'Personal toolbox / habits',createdAt:'9999-12-31T23:59:59.999Z',dateBasis:'UTC calendar labels (original toolbox dates)',coverage:'label and literal dates; source body not retained',textTruncated:true,titleTruncated:false}}]}}:null,
 before:r.source?{capturedAt:'9999-12-31T23:59:59.999Z',sourceFingerprint:'e1:'+'f'.repeat(64),baselineDays:Array(90).fill('9999-12-31')}:null,
 comparison:r.source?{capturedAt:'9999-12-31T23:59:59.999Z',status:'baseline-changed',sourceFingerprint:'e1:'+'f'.repeat(64),baselineDays:Array(90).fill('9999-12-31'),interventionDays:Array(90).fill('9999-12-31')}:null}))};}
function admit(s:State,mode:'content'|'lifecycle'|'remove') {const projected=future(s),limits={maxRecords:12},futureRecords=projected.records.map(record=>({feature:metadata.id,version:1,record}));checked(()=>assertQuota(s,mode==='content'?{kind:'content',records:s.records.map(envelope),limits,future:{value:projected,records:futureRecords}}:{kind:'lifecycle',records:s.records.map(envelope),limits}));if(mode!=='remove')checked(()=>assertQuota(projected,{kind:'lifecycle',records:futureRecords,limits}));for(const r of s.records)pages(JSON.stringify(envelope(r),null,2),`show ${r.id}`,r);}
async function habits(ctx:AgentFeatureContext){try{const items=await ctx.services.readContext(['habit']);if(items.length>100)throw new Error('Habit adapter item limit exceeded.');const seen=new Set<string>();return items.map(item=>{habit(item);if(seen.has(item.id))throw new Error('Duplicate source ID.');seen.add(item.id);
 // Validate the actual full adapter shape without retaining its duplicated JSON/body text.
 captureEvidence([item],{...evidenceOptions,maxBytes:65536});
 const projected:AgentContextItem={id:item.id,kind:'habit',title:item.title,text:'',...(item.updatedAt?{updatedAt:item.updatedAt}:{}),metadata:{...Object.fromEntries(evidenceOptions.metadataKeys.filter(k=>item.metadata?.[k]!==undefined).map(k=>[k,item.metadata![k]])),coverage:'label and literal dates; source body not retained',textTruncated:true,titleTruncated:item.metadata?.titleTruncated??false}};
 const evidence=captureEvidence([projected],evidenceOptions);return {item:evidence.sources[0],evidence,identityFingerprint:identity(evidence.sources[0])};}).sort((a,b)=>a.item.id.localeCompare(b.item.id));
 }catch(e){ctx.signal?.throwIfAborted();throw new InputError(contextCapacityMessage(e,'Check /nobo-help tools habits list; explicitly shorten/remove source records there before retrying.')??'Owned habit source could not be read completely or validated. Check /nobo-help tools habits list; shorten oversized source records or retry when available. Saved experiments are unchanged.');}}
function report(r:Experiment){let out=`Habit experiment: ${r.title}\nIntervention: ${r.intervention}\nWindows: ${JSON.stringify(r.windows)}\nSelected habit: ${r.source?(r.source.evidence.sources[0] as AgentContextItem).id:'none'}\n`;
 const c=r.comparison;out+=r.before?`Frozen before snapshot captured ${r.before.capturedAt}; baseline recorded dates ${r.before.baselineDays===null?'unknown (days absent)':r.before.baselineDays.join(', ')||'none (explicit empty array)'}\n`:'No frozen before snapshot.\n';
 if(!c)return out+'No comparison yet. Configure windows, attach a habit, then compare or freeze.\n';
 out+=`Saved comparison captured ${c.capturedAt}; status ${c.status}. Current source availability has not been checked since this capture.\n`;
 if(c.status==='source-absent'||c.status==='source-changed')return out+'Source absent from permitted snapshot or label/target/provenance changed. Previous evidence is invalid for current comparison; reselect with attach, then compare.\n';
 if(c.status==='baseline-changed')out+='STALE baseline: recorded baseline dates changed since freezing. Review both snapshots; reset-snapshot confirm, then freeze/compare explicitly.\n';
 const describe=(label:string,days:string[]|null,n:number|null)=>`${label}: recorded ${days===null?'unknown':days.length}; opportunities ${n===null?'unknown':n}; adherence ${n===null?'not shown (no explicit denominator)':days===null?'unknown (days absent)':n===0?'undefined (zero opportunities)':`${days.length}/${n} = ${(100*days.length/n).toFixed(1)}%`}; dates ${days?.join(', ')|| (days===null?'unknown':'none')}\n`;
 out+=describe('Current baseline',c.baselineDays,r.opportunities?.baseline??null)+describe('Intervention',c.interventionDays,r.opportunities?.intervention??null);
 if(c.sourceFingerprint!==r.source?.evidence.fingerprint)out+='Source snapshot changed since selection; comparison uses the freshly read dates shown above.\n';
 return out+'Dates are original UTC calendar labels, never caller-local midnight instants. Unlogged days are not failures. Frozen before capture may be retrospective; no causal claim or habit-store change.\n';}
async function execute(command:string,ctx:AgentFeatureContext):Promise<string>{
 checked(()=>boundedText(command,{label:'Command',maxBytes:16000}));if(command==='help')return metadata.help;const s=validate(await ctx.store.read('state')??initial),newId=randomUUID(),capturedAt=ctx.now.toISOString();
 const save=(change:(next:State)=>Experiment|null,mode:'content'|'lifecycle'|'remove'='content',render=false)=>ctx.store.update('state',initial,raw=>{const next=validate(raw),r=change(next);next.revision=bump(next.revision);validate(next);admit(next,mode);return {value:next,result:r&&render?pages(report(r),`report ${r.id}`,r):r?`Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} report ${r.id}`:'Deleted privately. Use list to inspect remaining experiments.'};});
 const edit=(key:string,change:(r:Experiment)=>void,mode:'content'|'lifecycle'|'remove'='content',render=false)=>{const expected=get(s,key);return save(next=>{const r=get(next,key);assertSame(r,expected);change(r);r.revision=bump(r.revision);return r;},mode,render);};
 const invalidate=(r:Experiment)=>{r.before=null;r.comparison=null;};let m:RegExpMatchArray|null;
 if((m=command.match(/^list(?: (?:page )?(\d+))?$/))){const n=checked(()=>parsePage(m![1])),all=[...s.records].sort((a,b)=>a.id.localeCompare(b.id));if(n>Math.max(1,Math.ceil(all.length/10)))throw new InputError('Page out of range; restart list.');return `Current list ${n}/${Math.max(1,Math.ceil(all.length/10))}; ${serializedBytes(s)}/49152 bytes\n`+(all.slice((n-1)*10,n*10).map(r=>`${r.id} · ${r.title||'untitled'} · ${r.comparison?.status??'not compared'}`).join('\n')||`No experiments. Start: ${metadata.example}`)+(n*10<all.length?`\nNext: ${route} list ${n+1}`:'');}
 if((m=command.match(/^(show|report) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[2]);guard(r,m[4],m[5]);return pages(m[1]==='show'?JSON.stringify(envelope(r),null,2):report(r),`${m[1]} ${r.id}`,r,checked(()=>parsePage(m![3])));}
 if((m=command.match(/^export (\S+)$/))){const out=envelope(get(s,m[1]));if(serializedBytes(out)>24576)throw new InputError('Export too large; use show pages.');return JSON.stringify(out);}
 if((m=command.match(/^delete (\S+)(?: (confirm))?$/))){const r=get(s,m[1]);if(!m[2])return `Remove experiment and snapshots only: ${route} delete ${r.id} confirm`;return save(next=>{assertSame(get(next,r.id),r);next.records=next.records.filter(x=>x.id!==r.id);return null;},'remove');}
 if(command.startsWith('create ')){const [title,intervention]=fields(command.slice(7),[120,300]);return save(next=>{const r:Experiment={id:newId,revision:1,title,intervention,windows:null,opportunities:null,source:null,before:null,comparison:null};next.records.push(r);return r;});}
 if((m=command.match(/^edit (\S+) (title|intervention)\s*\|([\s\S]*)$/))){const field=m[2] as 'title'|'intervention',[value]=fields(m[3],[field==='title'?120:300]);return edit(m[1],r=>{r[field]=value;invalidate(r);});}
 if((m=command.match(/^windows (\S+)\s*\|([\s\S]*)$/))){const [baselineStart,baselineEnd,interventionStart,interventionEnd]=fields(m[2],[10,10,10,10]).map(date),w={baselineStart,baselineEnd,interventionStart,interventionEnd};range(w);return edit(m[1],r=>{r.windows=w;r.opportunities=null;invalidate(r);},'lifecycle');}
 if((m=command.match(/^opportunities (\S+)\s*\|([\s\S]*)$/))){const [b,i]=fields(m[2],[7,7]),baseline=b==='unknown'?null:num(b,0,90),intervention=i==='unknown'?null:num(i,0,90);return edit(m[1],r=>{if(!r.windows)throw new InputError('Set windows first.');r.opportunities={baseline,intervention};denominators(r,r.before?.baselineDays??null,null);denominators(r,r.comparison?.baselineDays??null,r.comparison?.interventionDays??null);if(r.source){const days=validatedDays((r.source.evidence.sources[0] as AgentContextItem).metadata?.days);denominators(r,slice(days,r.windows.baselineStart,r.windows.baselineEnd),slice(days,r.windows.interventionStart,r.windows.interventionEnd));}invalidate(r);},'lifecycle');}
 if((m=command.match(/^clear (\S+) (title|intervention|windows|opportunities|source) confirm$/))){const field=m[2];return edit(m[1],r=>{if(field==='title'||field==='intervention')r[field]='';else if(field==='windows'){r.windows=null;r.opportunities=null;}else if(field==='opportunities')r.opportunities=null;else r.source=null;invalidate(r);},'remove');}
 if((m=command.match(/^reset-snapshot (\S+) confirm$/)))return edit(m[1],invalidate,'remove');
 if((m=command.match(/^habits (\S+)(?: page (\d+) rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[1]),sources=await habits(ctx),view={revision:r.revision,record:r,sources:sources.map(x=>({id:x.item.id,fingerprint:x.evidence.fingerprint}))};guard(view,m[3],m[4]);return pages('Owned habit selection; fresh complete bounded read. Label and literal date metadata only.\n'+(sources.map(x=>`${x.item.id} · ${x.item.title}\nFingerprint ${x.evidence.fingerprint}\n`).join('')||'No owned habits in this permitted snapshot.\n'),`habits ${r.id}`,view,checked(()=>parsePage(m![2])));}
 if((m=command.match(/^attach (\S+)\s*\|([\s\S]*)$/))){const key=m[1];get(s,key);const [sourceId,expectedFingerprint]=fields(m[2],m[2].includes('|')?[256,67]:[256]),sources=await habits(ctx),source=sources.find(x=>x.item.id===sourceId);if(!source)throw new InputError('Habit absent from this permitted snapshot; rerun habits.');if(expectedFingerprint&&expectedFingerprint!==source.evidence.fingerprint)throw new InputError('Habit changed; rerun habits before selecting.');if(Buffer.byteLength(source.item.title)>2000)throw new InputError('Selected habit label exceeds 2000 text bytes; shorten it in tools habits.');
  return edit(key,r=>{r.source={capturedAt,identityFingerprint:source.identityFingerprint,evidence:source.evidence};invalidate(r);},get(s,key).source?'lifecycle':'content');}
 if((m=command.match(/^(compare|freeze) (\S+)$/))){const verb=m[1],key=m[2],expected=get(s,key);if(!expected.windows||!expected.source||!expected.title.trim()||!expected.intervention.trim())throw new InputError('Complete title/intervention, windows and habit selection first.');if(verb==='freeze'&&expected.before)throw new InputError('Before snapshot is already frozen. Use reset-snapshot confirm to replace it explicitly.');
  const sources=await habits(ctx),source=sources.find(x=>x.item.id===(expected.source!.evidence.sources[0] as AgentContextItem).id),w=expected.windows;
  const changed=source&&source.identityFingerprint!==expected.source.identityFingerprint;
  const days=source?validatedDays(source.item.metadata?.days):null,b=slice(days,w.baselineStart,w.baselineEnd),i=slice(days,w.interventionStart,w.interventionEnd);
  if(source&&!changed)denominators(expected,b,i);
  const result=await edit(key,r=>{
   if(!source||changed){r.comparison={capturedAt,status:source?'source-changed':'source-absent',sourceFingerprint:source?.evidence.fingerprint??null,baselineDays:null,interventionDays:null};return;}
   r.before??={capturedAt,sourceFingerprint:source.evidence.fingerprint,baselineDays:b};
   r.comparison=verb==='freeze'?null:{capturedAt,status:stamp(r.before.baselineDays)===stamp(b)?'current':'baseline-changed',sourceFingerprint:source.evidence.fingerprint,baselineDays:b,interventionDays:i};
  },'lifecycle',true);
  return result;
 }
 throw new InputError(`Unknown or incomplete command. Use ${route} help`);
}
export default {...metadata,async execute(command:string,ctx:AgentFeatureContext){try{return await execute(command,ctx);}catch(e){ctx.signal?.throwIfAborted();return e instanceof InputError?`${e.message}\nNext: ${route} help`:`Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed.\nNext: ${route} list`;}}} satisfies AgentFeature;
