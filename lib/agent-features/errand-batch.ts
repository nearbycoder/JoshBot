import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, normalizeInstant } from "./feature-kit/civil-time.js";
import { ZonedTime, validDate } from "./day-planner/time.js";
import metadata from "./errand-batch.metadata.js";
const MAX_RECORDS=10, MINUTE=60000;
type Stop={id:string;name:string;serviceMinutes:number|null;window:string};
type Leg={from:string;to:string;minutes:number};
type RecordData={id:string;title:string;revision:number;createdAt:string;updatedAt:string;date:string|null;departure:string;departureAt:string|null;timezone:string;availableMinutes:number|null;startLabel:string;stops:Stop[];legs:Leg[]};
type State={version:1;records:RecordData[]};
const TIME="(?:[01]\\d|2[0-3]):[0-5]\\d(?:Z|[+-]\\d{2}:\\d{2})?";
function dateValue(v:unknown):string{const day=civilDate(v);if(!validDate(day))fail("Outing dates must be 1900–2200 for the shared timezone resolver.");return day;}
function timeValue(v:unknown):string{if(typeof v!=="string"||!new RegExp(`^${TIME}$`).test(v))fail("Use HH:mm, or HH:mm with explicit Z/±HH:mm offset in the outing timezone.");return v;}
function clockAt(day:string,time:string,zone:ZonedTime):number{
 timeValue(time);if(time.length===5)return zone.local(day,time);
 const at=Date.parse(normalizeInstant(`${day}T${time}`));
 if(zone.date(at)!==day||zone.clock(at).slice(0,5)!==time.slice(0,5))fail("Offset/time does not match the outing timezone; nonexistent local times cannot be scheduled.");return at;
}
function windowValue(v:unknown):string{if(typeof v!=="string"||!new RegExp(`^(${TIME})-(${TIME})$`).test(v))fail("Window must be HH:mm-HH:mm; each endpoint may include an explicit offset.");return v;}
function windowAt(r:RecordData,s:Stop,zone:ZonedTime):[number,number]|null{
 if(!r.date||!s.window)return null;const m=new RegExp(`^(${TIME})-(${TIME})$`).exec(s.window)!;
 const open=clockAt(r.date,m[1],zone),close=clockAt(r.date,m[2],zone);if(close<=open)fail("Closing time must follow opening on the same civil day.");return [open,close];
}
function refreshTime(r:RecordData):void{const z=new ZonedTime(r.timezone);r.departureAt=r.date&&r.departure?new Date(clockAt(r.date,r.departure,z)).toISOString():null;checkTimes(r,z);}
function checkTimes(r:RecordData,z:ZonedTime):void{if(r.departureAt&&r.availableMinutes!==null&&z.date(Date.parse(r.departureAt)+r.availableMinutes*MINUTE)!==r.date)fail("The outing budget must end on its supplied civil day (maximum 12 elapsed hours).");for(const stop of r.stops)windowAt(r,stop,z);}
function validateRecord(v:unknown):asserts v is RecordData{
 object(v,["id","title","revision","createdAt","updatedAt","date","departure","departureAt","timezone","availableMinutes","startLabel","stops","legs"]);validBase(v);
 if(v.date!==null)dateValue(v.date);validText(v.departure,11,true);if(v.departure)timeValue(v.departure);validText(v.timezone,100);validText(v.startLabel,160,true);if(v.availableMinutes!==null)validNumber(v.availableMinutes,1,720);
 if(!Array.isArray(v.stops)||v.stops.length>12||!Array.isArray(v.legs)||v.legs.length>156)throw new Error("Invalid stop/leg count.");
 for(const s of v.stops){object(s,["id","name","serviceMinutes","window"]);validId(s.id);validText(s.name,160,true);if(s.serviceMinutes!==null)validNumber(s.serviceMinutes,0,720);validText(s.window,23,true);if(s.window)windowValue(s.window);}unique(v.stops.map(s=>s.id));
 for(const l of v.legs){object(l,["from","to","minutes"]);for(const e of [l.from,l.to])if(typeof e!=="string"||(e!=="home"&&!v.stops.some(s=>s.id===e)))throw new Error("Invalid travel endpoint.");if(l.from===l.to)throw new Error("Self leg.");validNumber(l.minutes,0,720);}unique(v.legs.map(l=>`${l.from}>${l.to}`));
 const r=v as unknown as RecordData,z=new ZonedTime(r.timezone),expected=r.date&&r.departure?new Date(clockAt(r.date,r.departure,z)).toISOString():null;if(r.departureAt!==expected)throw new Error("Invalid departure instant.");checkTimes(r,z);
}
function projectLifecycle(s:State):State{return {...s,records:s.records.map(r=>({...r,revision:MAX_REVISION}))};}
function planLines(r:RecordData):string[]{
 const lines=[`${r.id} · ${r.title}`,`Civil day ${r.date??"unknown"}; saved caller timezone ${r.timezone}; home label ${r.startLabel||"unknown"}.`,"Stable greedy order: earliest closing instant, then entered order. No maps or optimality claim; entered estimates only."];
 if(!r.date||!r.departureAt||r.availableMinutes===null||!r.startLabel){lines.push("Incomplete outing: date, departure, budget or home label missing. Edit the missing field before planning.",`Next: ${ROUTE} show ${r.id}`);return lines;}
 const zone=new ZonedTime(r.timezone),start=Date.parse(r.departureAt),end=start+r.availableMinutes*MINUTE;let now=start,location="home",incomplete=false;
 lines.push(`Depart home ${zone.clock(start)}; available ${r.availableMinutes} elapsed minutes; return required by ${zone.clock(end)}.`);
 const order=r.stops.map((s,i)=>({s,i,w:windowAt(r,s,zone)})).sort((a,b)=>(a.w?.[1]??Infinity)-(b.w?.[1]??Infinity)||a.i-b.i);
 for(const {s,w} of order){lines.push(`Stop ${s.id} · ${s.name||"unknown name"}`);if(!w||s.serviceMinutes===null){lines.push("Unknown opening window/service duration; stop not scheduled.");incomplete=true;continue;}const leg=r.legs.find(l=>l.from===location&&l.to===s.id);if(!leg){lines.push(`Missing travel ${location} → ${s.id}: unknown, not zero; stop not scheduled.`);incomplete=true;continue;}
 const arrival=now+leg.minutes*MINUTE,begin=Math.max(arrival,w[0]),finish=begin+s.serviceMinutes*MINUTE;
 if(finish>w[1]||finish>end){lines.push(`Infeasible: would arrive ${zone.clock(arrival)}, finish ${zone.clock(finish)}; ${finish>w[1]?`closes ${zone.clock(w[1])}`:"exceeds outing budget"}. Not visited; prior location/time retained.`);incomplete=true;continue;}
 lines.push(`Travel ${location} → ${s.id}: ${leg.minutes} min; arrive ${zone.clock(arrival)}; wait ${(begin-arrival)/MINUTE} min until ${zone.clock(begin)}; service ${s.serviceMinutes} min → ${zone.clock(finish)}.`);now=finish;location=s.id;}
 if(location!=="home"){const home=r.legs.find(l=>l.from===location&&l.to==="home");if(!home){lines.push(`Return home: missing ${location} → home; travel and total are unknown. Outing feasibility is unconfirmed.`);incomplete=true;}else{now+=home.minutes*MINUTE;const used=(now-start)/MINUTE;lines.push(`Return home: ${home.minutes} min → ${zone.clock(now)}; total ${used}/${r.availableMinutes} min including travel, waits, service and return.`);if(now>end){lines.push(`Infeasible return: ${used-r.availableMinutes} min over budget; retained visibly.`);incomplete=true;}if(zone.date(now)!==r.date){lines.push("Infeasible return: outside the supplied civil day.");incomplete=true;}}}else lines.push("Home unchanged; 0 elapsed minutes; no stop visited.");
 lines.push(`Coverage: ${incomplete?"incomplete/infeasible entries above remain unscheduled or unconfirmed":"all entered stops and return fit these supplied estimates"}.`,`Next: ${ROUTE} show ${r.id}`);return lines;
}
async function executeDomain(verb:string,rest:string,context:AgentFeatureContext):Promise<string>{
 if(verb==="create"){const [title,date,departure,budget,home]=fields(rest,160,10,11,3,160),r:RecordData={...base(context,"outing",text(title,"Outing",160)),date:checked(()=>dateValue(date)),departure:timeValue(departure),departureAt:null,timezone:context.timezone,availableMinutes:integer(budget,1,720,"Available minutes"),startLabel:text(home,"Home label",160),stops:[],legs:[]};checked(()=>refreshTime(r));return mutate(context,undefined,s=>{s.records.push(r);return saved(r.id,"Outing saved in caller timezone; home is the reserved travel endpoint. Enter stops and directed travel legs.");});}
 if(verb==="edit"||verb==="clear"){const v=verb==="edit"?fields(rest,80,20,160):words(rest,3);if(verb==="clear"&&v[2]!=="confirm")fail("Use clear ID FIELD confirm.");return mutate(context,v[0],(_,r)=>{const k=v[1],value=verb==="clear"?"":v[2];if(k==="title"||k==="startLabel")r![k]=text(value,k,160,verb==="clear");else if(k==="date")r!.date=verb==="clear"?null:checked(()=>dateValue(value));else if(k==="departure")r!.departure=verb==="clear"?"":timeValue(value);else if(k==="availableMinutes")r!.availableMinutes=verb==="clear"?null:integer(value,1,720,"Available minutes");else if(k==="timezone"&&verb==="edit")r!.timezone=text(value,"Timezone",100);else fail("Fields: title, date, departure, availableMinutes, startLabel; edit also accepts timezone.");checked(()=>refreshTime(r!));return saved(v[0],"Outing updated; plan recomputes from current supplied data.",`plan ${v[0]}`);},verb==="clear"?"remove":"content");}
 if(verb==="stop"){
  const m=/^(\S+)\s+(add|edit|remove|clear)\s+([\s\S]+)$/.exec(rest);if(!m)fail("Use stop ID add NAME | SERVICE_MINUTES | WINDOW; see help for edit/remove.");const [,id,mode,input]=m;
  if(mode==="remove"||mode==="clear"){const v=words(input,mode==="remove"?2:3);if(v.at(-1)!=="confirm")fail("Stop removal/clear requires confirm.");return mutate(context,id,(_,r)=>{const s=r!.stops.find(s=>s.id===v[0]);if(!s)fail("Stop not found in this outing.");if(mode==="remove"){r!.stops=r!.stops.filter(x=>x!==s);r!.legs=r!.legs.filter(l=>l.from!==s.id&&l.to!==s.id);}else if(v[1]==="name"||v[1]==="window")s[v[1]]="";else if(v[1]==="serviceMinutes")s.serviceMinutes=null;else fail("Stop clear fields: name, window, serviceMinutes.");return saved(id,"Stop field removed; deleting a stop also removes its incident travel legs.",`plan ${id}`);},"remove");}
  const v=fields(input,...(mode==="edit"?[80]:[]),160,3,23),child=mode==="edit"?v.shift()!:`stop-${randomUUID()}`,entry:Stop={id:child,name:text(v[0],"Stop",160),serviceMinutes:integer(v[1],0,720,"Service minutes"),window:windowValue(v[2])};
  return mutate(context,id,(_,r)=>{if(mode==="add"){if(r!.stops.length>=12)fail("Maximum 12 stops.");r!.stops.push(entry);}else{const s=r!.stops.find(s=>s.id===child);if(!s)fail("Stop not found.");Object.assign(s,entry);}checked(()=>refreshTime(r!));return saved(id,`Stop ${child} saved; add directed travel from home/other stop IDs.`,`plan ${id}`);});
 }
 if(verb==="travel"||verb==="untravel"){const [id,from,to,last]=fields(rest,80,80,80,7);if(verb==="untravel"&&last!=="confirm")fail("Use untravel ID | FROM | TO | confirm.");const minutes=verb==="travel"?integer(last,0,720,"Travel minutes"):0;return mutate(context,id,(_,r)=>{for(const e of [from,to])if(e!=="home"&&!r!.stops.some(s=>s.id===e))fail("Travel endpoints must be home or full stop IDs in this outing.");if(from===to)fail("Travel endpoints must differ.");const leg=r!.legs.find(l=>l.from===from&&l.to===to);if(verb==="untravel"){if(!leg)fail("Directed leg not found.");r!.legs=r!.legs.filter(l=>l!==leg);}else if(leg)leg.minutes=minutes;else{if(r!.legs.length>=156)fail("Maximum 156 directed legs.");r!.legs.push({from,to,minutes});}return saved(id,"Directed travel estimate updated; reverse travel is not inferred.",`plan ${id}`);},verb==="untravel"?"remove":"content");}
 if(verb==="plan"){const args=words(rest,1,4),r=find(await read(context),args[0]);return report(planLines(r),`plan ${r.id}`,recordPage(r,`plan ${r.id}`,args.slice(1)),"Private · unsaved errand estimate",pageVersion(r));}
 fail("Unknown command. Use help for supported syntax.");
}
const ROUTE = `/nobo-help agent ${metadata.id}`;
const MAX_REVISION = 999_999_999;
const EMPTY: State = { version: 1, records: [] };
class CommandError extends Error {}
function fail(message: string): never { throw new CommandError(message); }
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { if (error instanceof Error) fail(error.message); throw error; }
}
function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  return checked(() => boundedText(value, { label, maxBytes, allowEmpty }));
}
function fields(input: string, ...limits: number[]): string[] {
  return checked(() => pipeFields(input, limits.map((maxBytes, i) => ({ label: `Field ${i + 1}`, maxBytes: maxBytes + 2, allowEmpty: true }))).map((value, i) => boundedText(value, { label: `Field ${i + 1}`, maxBytes: limits[i], allowEmpty: true })));
}
function integer(value: string, min: number, max: number, label = "Minutes"): number {
  return checked(() => parseInteger(value, { min, max, label }));
}
function words(value: string, min: number, max = min): string[] {
  const parts = value.trim() ? value.trim().split(/\s+/u) : [];
  if (parts.length < min || parts.length > max) fail("Wrong arguments. Use the exact syntax in help.");
  return parts;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) throw new Error("Invalid object fields.");
}
function validText(value: unknown, maxBytes: number, allowEmpty = false): void {
  boundedText(value, { label: "Saved text", maxBytes, allowEmpty, trim: false });
}
function validNumber(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error("Invalid number.");
}
function validId(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error("Duplicate values.");
}
function validBase(record: Record<string, unknown>): void {
  validId(record.id); validText(record.title, 160, true); validNumber(record.revision, 1, MAX_REVISION);
  for (const value of [record.createdAt, record.updatedAt]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid timestamp.");
  }
}
function decode(value: unknown): State {
  try {
    serializedBytes(value); assertStateVersion(value, 1); object(value, ["version", "records"]);
    if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("Invalid records.");
    for (const record of value.records) validateRecord(record);
    unique(value.records.map(record => record.id));
    return value as unknown as State;
  } catch { fail("Saved data could not be read safely. It was preserved; no reset or mutation was performed."); }
}
const envelope = (record: RecordData) => ({ feature: metadata.id, version: 1, record });
function quota(state: State, kind: "content" | "lifecycle"): void {
  checked(() => {
    const future = projectLifecycle(state);
    assertQuota(state, kind === "content"
      ? { kind, records: state.records.map(envelope), future: { value: future, records: future.records.map(envelope) }, limits: { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS } }
      : { kind, records: state.records.map(envelope), limits: { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS } });
  });
}
function find(state: State, id: string): RecordData {
  const result = state.records.find(record => record.id === id);
  if (!result) fail("Item not found in your private records. Use list to find a saved ID.");
  return result;
}
async function read(context: AgentFeatureContext): Promise<State> {
  const value = await context.store.read<unknown>("state");
  context.signal?.throwIfAborted();
  return value === null ? structuredClone(EMPTY) : decode(value);
}
async function mutate(context: AgentFeatureContext, id: string | undefined, change: (state: State, record?: RecordData) => string,
  kind: "content" | "lifecycle" | "remove" = "content"): Promise<string> {
  // Bind intent once, outside the retryable transform. The snapshot also guards
  // removals at the revision ceiling; unrelated records may still retry.
  const intended = id === undefined ? undefined : JSON.stringify(find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, current => {
    const state = structuredClone(decode(current));
    const record = id === undefined ? undefined : find(state, id);
    if (record && JSON.stringify(record) !== intended) fail(`This item changed before the command could be saved. Inspect it, then retry: ${ROUTE} show ${id}`);
    const result = change(state, record);
    if (record && state.records.includes(record)) {
      if (record.revision >= MAX_REVISION && kind === "content") fail("Revision limit reached. Export this record and create a new one.");
      record.revision = Math.min(MAX_REVISION, record.revision + 1); record.updatedAt = timestamp;
    }
    if (state.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, export, then delete ID confirm to free space.`);
    decode(state);
    // Removal remains possible for readable legacy state over the current byte cap.
    if (kind !== "remove") quota(state, kind);
    else if (serializedBytes(state) > serializedBytes(current)) quota(state, "lifecycle");
    return { value: state, result };
  });
}
function base(context: AgentFeatureContext, prefix: string, title: string) {
  return { id: `${prefix}-${randomUUID()}`, title, revision: 1, createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() };
}
function saved(id: string, detail: string, next = `show ${id}`): string {
  return `Saved privately: ${id}\n${detail}\nNext: ${ROUTE} ${next}`;
}
// A content stamp keeps removals at the revision ceiling distinguishable too.
function pageVersion(record: RecordData): string {
  return `${record.revision}-${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}
function recordPage(record: RecordData, command: string, args: string[]): number {
  if (args.length !== 0 && args.length !== 1 && args.length !== 3) fail("Use PAGE rev REV from the emitted continuation, or restart page 1.");
  const page = checked(() => parsePage(args[0]));
  if (args.length === 3) {
    if (args[1] !== "rev" || !/^[1-9]\d{0,8}-[a-f0-9]{64}$/.test(args[2])) fail("Invalid revision token. Copy the complete continuation or restart page 1.");
    if (args[2] !== pageVersion(record)) fail(`This item changed; stale continuation rejected. Restart page 1: ${ROUTE} ${command} 1`);
  }
  return page;
}
function view(parts: { text: string; atomic?: boolean }[], command: string, page = 1, title = "Private · unsaved report", revision?: string): string {
  return checked(() => pageAt(paginateParts(parts, { mode: "plain", title, command: n => `${ROUTE} ${command} ${n}${revision ? ` rev ${revision}` : ""}` }), page).text);
}
function report(lines: string[], command: string, page = 1, title?: string, revision?: string): string {
  return view(lines.map(line => ({ text: `${line}\n`, atomic: true })), command, page, title, revision);
}
async function common(verb: string, rest: string, context: AgentFeatureContext): Promise<string | undefined> {
  if (verb === "list") {
    const args = words(rest, 0, 1), page = checked(() => parsePage(args[0]));
    const state = await read(context), total = Math.max(1, Math.ceil(state.records.length / 10));
    if (page > total) fail(`Current list has ${total} page(s). Reopen list 1.`);
    if (!state.records.length) return `No saved items yet.\nNext: ${metadata.example}`;
    const rows = state.records.slice((page - 1) * 10, page * 10).map(r => `${r.id} — ${(r.title || "(title cleared)").replace(/[\r\n]/g, " ")} · revision ${r.revision}`);
    return `Private · current list · page ${page}/${total} · ${(page - 1) * 10 + 1}–${Math.min(page * 10, state.records.length)} of ${state.records.length}\n${rows.join("\n")}\nNext: ${ROUTE} ${page < total ? `list ${page + 1}` : `show ${state.records[(page - 1) * 10].id}`}`;
  }
  if (verb === "show" || verb === "export") {
    const args = words(rest, 1, verb === "show" ? 4 : 1), record = find(await read(context), args[0]);
    if (verb === "export") {
      const result = JSON.stringify(envelope(record));
      if (serializedBytes(envelope(record)) > 24_576) fail(`This legacy record exceeds the export ceiling. Retrieve all parts with show ${record.id}.`);
      return result;
    }
    const json = JSON.stringify(envelope(record), null, 2);
    // Every field is <=1000 UTF-8 bytes (<=2000 serialized units with escapes); IDs and JSON lines stay intact.
    return view(json.split("\n").map(line => ({ text: line + "\n", atomic: true })), `show ${record.id}`, recordPage(record, `show ${record.id}`, args.slice(1)),
      `Saved privately: ${record.id} · revision ${record.revision}`, pageVersion(record));
  }
  if (verb === "delete") {
    const args = words(rest, 1, 2);
    if (args[1] !== undefined && args[1] !== "confirm") fail("Use delete ID confirm.");
    if (args[1] !== "confirm") {
      const record = find(await read(context), args[0]);
      return `Delete ${record.id} and all its owned children?\nNext: ${ROUTE} delete ${record.id} confirm`;
    }
    return mutate(context, args[0], state => {
      state.records = state.records.filter(record => record.id !== args[0]);
      return `Deleted privately: ${args[0]} and its owned children.\nNext: ${ROUTE} list`;
    }, "remove");
  }
  return undefined;
}

export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      text(command, "Command", 16_000);
      context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim())!;
      const verb = match[1], rest = match[2] ?? "";
      return await common(verb, rest, context) ?? await executeDomain(verb, rest, context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
