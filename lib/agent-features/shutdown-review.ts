import {createHash, randomUUID} from 'node:crypto';
import * as v from 'valibot';
import {assertQuota, assertStateVersion, serializedBytes} from './feature-kit/bounded-state.js';
import {civilDate, normalizeInstant} from './feature-kit/civil-time.js';
import {boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart} from './feature-kit/command-and-display.js';
import metadata from './shutdown-review.metadata.js';
import type {AgentFeature, AgentFeatureContext} from './types.js';
const route = '/nobo-help agent shutdown-review';
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
  return body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|(?:calendar|toolbox):[A-Za-z0-9:_-]+|e1:[0-9a-f]{64})/g)
    .map((text, i) => ({text, atomic: i % 2 === 1}));
}
function pages(body: string, command: string, value: {revision: number}, page = 1) {
  return checked(() => pageAt(paginateParts(parts(body), {mode: 'plain', title: `Revision ${value.revision}`,
    command: n => `${route} ${command} page ${n} rev ${value.revision} stamp ${stamp(value)}`}), page).text);
}
const dispositionSchema = v.strictObject({kind:v.picklist(['done','defer','drop','wait']),nextReview:v.nullable(daySchema),reason:text(160)});
const loopSchema=v.strictObject({id:idSchema,text:text(300),disposition:v.nullable(dispositionSchema)});
const questionSchema=v.strictObject({id:idSchema,text:text(240)});
const recordSchema=v.strictObject({id:idSchema,revision:revSchema,day:daySchema,loops:v.pipe(v.array(loopSchema),v.maxLength(20)),
  questions:v.pipe(v.array(questionSchema),v.maxLength(10)),firstStep:text(300),closedAt:v.nullable(instantSchema)});
const schema=v.strictObject({version:v.literal(1),revision:revSchema,records:v.pipe(v.array(recordSchema),v.maxLength(20))});
type State=v.InferOutput<typeof schema>;
type Review=State['records'][number];
const initial:State={version:1,revision:1,records:[]};
const envelope=(record:Review)=>({feature:metadata.id,version:1,record});
function missing(r:Review) {return [...r.loops.filter(l=>!l.disposition).map(l=>`Disposition needed: ${l.id}`),...(!r.firstStep.trim()?['Tomorrow first step is required.']:[])];}
function validate(raw:unknown):State {
 checked(()=>assertStateVersion(raw,1));const p=v.safeParse(schema,raw);
 if(!p.success)throw new InputError('Invalid saved shutdown-review schema; data preserved. Ask the operator for scoped recovery.');
 const s=p.output,ids:string[]=[];
 for(const r of s.records){ids.push(r.id,...r.loops.map(l=>l.id),...r.questions.map(q=>q.id));
  if(r.questions.some(q=>!q.text.trim())||r.loops.some(l=>!l.text.trim())||r.closedAt&&missing(r).length)throw new InputError('Invalid saved closure; data preserved.');
  for(const l of r.loops)if(l.disposition){const d=l.disposition;
   if(!d.reason.trim()||((d.kind==='defer'||d.kind==='wait')?(!d.nextReview||d.nextReview<r.day):d.nextReview!==null))throw new InputError('Invalid saved disposition/review date; data preserved.');
  }
 }
 if(new Set(ids).size!==ids.length||new Set(s.records.map(r=>r.day)).size!==s.records.length)throw new InputError('Duplicate saved IDs or days; data preserved.');
 return s;
}
const get=(s:State,id:string)=>{const r=s.records.find(x=>x.id===id);if(!r)throw new InputError('Review not found. Use list.');return r;};
function future(s:State):State {return {...s,revision:Number.MAX_SAFE_INTEGER,records:s.records.map(r=>({...r,revision:Number.MAX_SAFE_INTEGER,
 firstStep:'\\'.repeat(300),closedAt:'9999-12-31T23:59:59.999Z',loops:r.loops.map(l=>({...l,disposition:{kind:'defer',nextReview:'9999-12-31',reason:'\\'.repeat(160)}}))}))};}
function admit(s:State,mode:'content'|'lifecycle'|'remove') {
 const projected=future(s),limits={maxRecords:20};
 checked(()=>assertQuota(s,mode==='content'?{kind:'content',records:s.records.map(envelope),limits,future:{value:projected,records:projected.records.map(envelope)}}:{kind:'lifecycle',records:s.records.map(envelope),limits}));
 if(mode!=='remove')checked(()=>assertQuota(projected,{kind:'lifecycle',records:projected.records.map(envelope),limits}));
}
function check(r:Review) {
 return `Workday closure ${r.day} · ${r.closedAt?'closed at '+r.closedAt:'open'}\n`+
  (missing(r).join('\n')||'All required fields are complete.')+'\n'+
  r.loops.map(l=>`Loop ${l.id}: ${l.text}\n${l.disposition?`${l.disposition.kind} (local self-report); next review ${l.disposition.nextReview??'not applicable'}; ${l.disposition.reason}`:'No disposition'}\n`).join('')+
  'Unresolved questions (recorded, not claimed answered):\n'+(r.questions.map(q=>`${q.id}: ${q.text}\n`).join('')||'None entered.\n')+
  `Tomorrow first step: ${r.firstStep||'(missing)'}\nNo external task was completed, changed or sent.\n`;
}
async function execute(command:string,ctx:AgentFeatureContext):Promise<string> {
 checked(()=>boundedText(command,{label:'Command',maxBytes:16000}));if(command==='help')return metadata.help;
 const s=validate(await ctx.store.read('state')??initial),newId=randomUUID(),now=ctx.now.toISOString();
 const save=(change:(next:State)=>Review|null,mode:'content'|'lifecycle'|'remove'='content')=>ctx.store.update('state',initial,raw=>{
  const next=validate(raw),r=change(next);next.revision=bump(next.revision);validate(next);admit(next,mode);
  return {value:next,result:r?`Saved privately: ${r.id} · ${r.closedAt?'closed':'open'} · revision ${r.revision}\nNext: ${route} check ${r.id}`:'Deleted privately. Use list to inspect remaining reviews.'};
 });
 const edit=(key:string,change:(r:Review)=>void,mode:'content'|'lifecycle'|'remove'='content',closing=false)=>{
  const expected=get(s,key);return save(next=>{const r=get(next,key);assertSame(r,expected);if(!closing)r.closedAt=null;change(r);r.revision=bump(r.revision);return r;},mode);
 };
 let m:RegExpMatchArray|null;
 if((m=command.match(/^list(?: (?:page )?(\d+))?$/))){const n=checked(()=>parsePage(m![1])),all=[...s.records].sort((a,b)=>a.day.localeCompare(b.day)||a.id.localeCompare(b.id));
  if(n>Math.max(1,Math.ceil(all.length/10)))throw new InputError('Page out of range; restart list.');
  return `Current list ${n}/${Math.max(1,Math.ceil(all.length/10))}; ${serializedBytes(s)}/49152 bytes\n`+(all.slice((n-1)*10,n*10).map(r=>`${r.id} · ${r.day} · ${r.closedAt?'closed':'open'} · ${r.loops.length} loops`).join('\n')||`No reviews. Start: ${metadata.example}`)+(n*10<all.length?`\nNext: ${route} list ${n+1}`:'');
 }
 if((m=command.match(/^(show|check) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+) stamp ([0-9a-f]{64}))?$/))){const r=get(s,m[2]);guard(r,m[4],m[5]);return pages(m[1]==='show'?JSON.stringify(envelope(r),null,2):check(r),`${m[1]} ${r.id}`,r,checked(()=>parsePage(m![3])));}
 if((m=command.match(/^export (\S+)$/))){const out=envelope(get(s,m[1]));if(serializedBytes(out)>24576)throw new InputError('Export too large; use show pages.');return JSON.stringify(out);}
 if((m=command.match(/^delete (\S+)(?: (confirm))?$/))){const r=get(s,m[1]);if(!m[2])return `Remove review and all loops/questions: ${route} delete ${r.id} confirm`;
  return save(next=>{assertSame(get(next,r.id),r);next.records=next.records.filter(x=>x.id!==r.id);return null;},'remove');}
 if((m=command.match(/^start (\S+)$/))){const day=date(m[1]);return save(next=>{if(next.records.some(r=>r.day===day))throw new InputError('This civil day already has a review; use list.');const r:Review={id:newId,revision:1,day,loops:[],questions:[],firstStep:'',closedAt:null};next.records.push(r);return r;});}
 if((m=command.match(/^edit (\S+) day\s*\|([\s\S]*)$/))){const [day]=fields(m[2],[10]);date(day);return edit(m[1],r=>{r.day=day;for(const l of r.loops)l.disposition=null;});}
 if((m=command.match(/^(loop|question) (\S+) add ([\s\S]+)$/))){const [,verb,key,input]=m,[text]=fields(input,[verb==='loop'?300:240]);
  return edit(key,r=>{if(verb==='loop')r.loops.push({id:newId,text,disposition:null});else r.questions.push({id:newId,text});});}
 if((m=command.match(/^(loop|question) (\S+) edit (\S+)\s*\|([\s\S]*)$/))){const [,verb,key,cid,input]=m,[text]=fields(input,[verb==='loop'?300:240]);
  return edit(key,r=>{if(verb==='loop'){const l=r.loops.find(l=>l.id===cid);if(!l)throw new InputError('Loop not found.');l.text=text;l.disposition=null;}else{const q=r.questions.find(q=>q.id===cid);if(!q)throw new InputError('Question not found.');q.text=text;}});}
 if((m=command.match(/^(loop|question) (\S+) remove (\S+) confirm$/))){const [,verb,key,cid]=m;return edit(key,r=>{
  if(verb==='loop'){if(!r.loops.some(l=>l.id===cid))throw new InputError('Loop not found.');r.loops=r.loops.filter(l=>l.id!==cid);}
  else{if(!r.questions.some(q=>q.id===cid))throw new InputError('Question not found.');r.questions=r.questions.filter(q=>q.id!==cid);}},'remove');}
 if((m=command.match(/^disposition (\S+) (\S+)\s*\|([\s\S]*)$/))){const [,key,lid,input]=m,[kind,review,reason]=fields(input,[5,10,160]);
  if(kind!=='done'&&kind!=='defer'&&kind!=='drop'&&kind!=='wait')throw new InputError('Disposition must be done, defer, drop or wait.');
  const nextReview=review==='none'?null:date(review);
  if((kind==='defer'||kind==='wait')?!nextReview:nextReview!==null)throw new InputError('Defer/wait require a review date; done/drop require none.');
  return edit(key,r=>{const l=r.loops.find(l=>l.id===lid);if(!l)throw new InputError('Loop not found.');if(nextReview&&nextReview<r.day)throw new InputError('Next-review date must be on or after the review day.');l.disposition={kind,nextReview,reason};},'lifecycle');}
 if((m=command.match(/^clear-disposition (\S+) (\S+) confirm$/))){const [,key,lid]=m;return edit(key,r=>{const l=r.loops.find(l=>l.id===lid);if(!l)throw new InputError('Loop not found.');l.disposition=null;},'remove');}
 if((m=command.match(/^first-step (\S+)\s*\|([\s\S]*)$/))){const [value]=fields(m[2],[300]);return edit(m[1],r=>{r.firstStep=value;},'lifecycle');}
 if((m=command.match(/^clear (\S+) first-step confirm$/)))return edit(m[1],r=>{r.firstStep='';},'remove');
 if((m=command.match(/^reopen (\S+)$/)))return edit(m[1],()=>{},'remove');
 if((m=command.match(/^close (\S+)$/)))return edit(m[1],r=>{if(missing(r).length)throw new InputError('Closure incomplete. Address every loop and set first-step; use check.');r.closedAt=now;},'lifecycle',true);
 throw new InputError(`Unknown or incomplete command. Use ${route} help`);
}
export default {...metadata,async execute(command:string,ctx:AgentFeatureContext){try{return await execute(command,ctx);}catch(e){ctx.signal?.throwIfAborted();return e instanceof InputError?`${e.message}\nNext: ${route} help`:`Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed.\nNext: ${route} list`;}}} satisfies AgentFeature;
