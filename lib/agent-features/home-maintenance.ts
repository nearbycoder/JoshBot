import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, addCivilDays, civilDaysBetween, dateInZone } from "./feature-kit/civil-time.js";
import metadata from "./home-maintenance.metadata.js";
const MAX_RECORDS=30;
type Service={id:string;date:string;meter:number|null;note:string;correctionReason:string};
type RecordData={id:string;title:string;revision:number;createdAt:string;updatedAt:string;manual:string;intervalDays:number|null;intervalUsage:number|null;latestMeter:number|null;latestReason:string;services:Service[]};
type State={version:1;records:RecordData[]};
function usage(v:string,positive=false):number {if(!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(v))fail("Usage must be decimal 0–1000000000, at most 3 places.");const [a,b=""]=v.split("."),n=BigInt(a)*1000n+BigInt(b.padEnd(3,"0"));if(n>1_000_000_000_000n||(positive&&n===0n))fail("Usage interval must be positive; readings at most 1000000000.");return Number(n);}
function units(n:number):string{return `${Math.floor(n/1000)}.${String(n%1000).padStart(3,"0")}`.replace(/\.?0+$/,"");}
function last(r:RecordData):Service|undefined{return r.services.slice().sort((a,b)=>a.date.localeCompare(b.date)||r.services.indexOf(a)-r.services.indexOf(b)).at(-1);}
function readingFloor(r:RecordData):number {
 const lastKnown=last({...r,services:r.services.filter(s=>s.meter!==null)})?.meter??0;
 // A reasoned correction starts a new monotonic sequence. Keep its reason until
 // a metered service incorporates it, rather than comparing against older epochs.
 return r.latestReason&&r.latestMeter!==null?r.latestMeter:Math.max(r.latestMeter??0,lastKnown);
}
function validateRecord(v:unknown):asserts v is RecordData{
 object(v,["id","title","revision","createdAt","updatedAt","manual","intervalDays","intervalUsage","latestMeter","latestReason","services"]);validBase(v);validText(v.manual,1000,true);validText(v.latestReason,160,true);
 if(v.intervalDays!==null)validNumber(v.intervalDays,1,3650);if(v.intervalUsage!==null)validNumber(v.intervalUsage,1,1_000_000_000_000);if(v.latestMeter!==null)validNumber(v.latestMeter,0,1_000_000_000_000);
 if(!Array.isArray(v.services)||v.services.length>10)throw new Error("Invalid service history.");
 for(const s of v.services){object(s,["id","date","meter","note","correctionReason"]);validId(s.id);civilDate(s.date);if(s.meter!==null)validNumber(s.meter,0,1_000_000_000_000);validText(s.note,160,true);validText(s.correctionReason,160,true);}unique(v.services.map(s=>s.id));
 const r=v as unknown as RecordData,ordered=r.services.slice().sort((a,b)=>a.date.localeCompare(b.date)||r.services.indexOf(a)-r.services.indexOf(b));let previous:number|null=null;
 for(const s of ordered){if(s.meter!==null){if(previous!==null&&s.meter<previous&&!s.correctionReason)throw new Error("Unexplained decreasing service reading.");previous=s.meter;}}
 const baseline=last(r);if(baseline&&r.intervalDays!==null)addCivilDays(baseline.date,r.intervalDays);
}
function projectLifecycle(s:State):State{
 // All remaining ten service slots, not a constant cushion. Explicit corrections
 // are optional new content; ordinary service completion notes are reserved.
 return {...s,records:s.records.map(r=>({...r,revision:MAX_REVISION,latestMeter:1_000_000_000_000,services:[...r.services.map(e=>({...e,meter:1_000_000_000_000,note:"\n".repeat(160)})),...Array.from({length:10-r.services.length},(_,i)=>({id:`service-00000000-0000-0000-0000-${String(i).padStart(12,"0")}`,date:"9999-12-31",meter:1_000_000_000_000,note:"\n".repeat(160),correctionReason:""}))]}))};
}
function dueLines(r:RecordData,day:string):string[]{
 const s=last(r),lines=[`${r.id} · ${r.title}`,`Supplied manual: ${r.manual||"unknown"}`];let due=false,unknown=false,active=0;
 if(r.intervalDays!==null){active++;if(!s){unknown=true;lines.push("Date threshold unknown: no last service date.");}else{const date=addCivilDays(s.date,r.intervalDays),delta=civilDaysBetween(date,day);due ||= delta>=0;lines.push(`Next date ${date}; ${delta>0?`${delta} civil days overdue`:delta===0?"due today":`${-delta} civil days remaining`}.`);}}
 else lines.push("Date threshold: not supplied.");
 if(r.intervalUsage!==null){active++;if(s?.meter===null||s===undefined||r.latestMeter===null||r.latestMeter<s.meter){unknown=true;lines.push("Usage threshold unknown: baseline/latest reading missing, or corrected latest below baseline.");}else{const threshold=s.meter+r.intervalUsage,delta=r.latestMeter-threshold;due ||=delta>=0;lines.push(`Usage threshold ${units(threshold)}; latest ${units(r.latestMeter)}; ${delta>=0?`${units(delta)} usage units past threshold`:`${units(-delta)} usage units remaining`}.`);}}
 else lines.push("Usage threshold: not supplied.");
 lines.push(`Status: ${due?"due (at least one supplied threshold met)":unknown||!active?"unknown":"not due on supplied thresholds"}${due&&unknown?"; other threshold unknown":""}.`,"No interval or maintenance advice inferred.",`Next: ${ROUTE} history ${r.id}`);return lines;
}
function setField(r:RecordData,k:string,v:string,clear=false):void{
 if(k==="title"||k==="manual")r[k]=text(v,k,k==="title"?160:1000,clear);
 else if(k==="intervalDays")r.intervalDays=clear||v==="none"?null:integer(v,1,3650,"Interval days");
 else if(k==="intervalUsage")r.intervalUsage=clear||v==="none"?null:usage(v,true);
 else if(clear&&k==="latestMeter"){r.latestMeter=null;r.latestReason="";}
 else if(clear&&k==="latestReason")r.latestReason="";
 else fail("Field must be title, manual, intervalDays, intervalUsage. clear also accepts latestMeter/latestReason; use meter/correct for readings.");
 const baseline=last(r);if(baseline&&r.intervalDays!==null)checked(()=>addCivilDays(baseline.date,r.intervalDays!));
}
async function executeDomain(verb:string,rest:string,context:AgentFeatureContext):Promise<string>{
 if(verb==="add"){const v=fields(rest,160,1000,4,14),r:RecordData={...base(context,"asset",text(v[0],"Asset",160)),manual:text(v[1],"Manual label",1000),intervalDays:null,intervalUsage:null,latestMeter:null,latestReason:"",services:[]};setField(r,"intervalDays",v[2]);setField(r,"intervalUsage",v[3]);return mutate(context,undefined,s=>{s.records.push(r);return saved(r.id,"Supplied intervals saved. Record an actual service to establish baselines.");});}
 if(verb==="edit"||verb==="clear"){const v=verb==="edit"?fields(rest,80,20,1000):words(rest,3);if(verb==="clear"&&v[2]!=="confirm")fail("Use clear ID FIELD confirm.");return mutate(context,v[0],(_,r)=>{setField(r!,v[1],verb==="clear"?"":v[2],verb==="clear");return saved(v[0],"Entered field updated; due thresholds recomputed.");},verb==="clear"?"remove":"content");}
 if(verb==="meter"||verb==="correct"){const v=verb==="meter"?fields(rest,80,14):fields(rest,80,14,160),n=usage(v[1]);if(verb==="correct")text(v[2],"Correction reason",160);return mutate(context,v[0],(_,r)=>{const floor=readingFloor(r!);if(verb==="meter"&&n<floor)fail("Decreasing meter requires correct ID | VALUE | REASON.");r!.latestMeter=n;if(verb==="correct")r!.latestReason=v[2];return saved(v[0],"Latest supplied reading saved; no usage inferred.");},verb==="meter"?"lifecycle":"content");}
 if(verb==="service"){const [id,date,reading,note]=fields(rest,80,10,14,160);checked(()=>civilDate(date));if(date>dateInZone(context.now,context.timezone))fail("Service date must be an actual past/today civil date.");text(note,"Service note",160);const entry:Service={id:`service-${randomUUID()}`,date,meter:reading==="none"?null:usage(reading),note,correctionReason:""};return mutate(context,id,(_,r)=>{if(r!.services.length>=10)fail("Maximum 10 service records. Inspect history and explicitly remove one before adding.");const previous=last(r!);if(previous&&date<previous.date)fail("New service cannot precede the last service; use history edit with a correction reason.");if(entry.meter!==null&&entry.meter<readingFloor(r!))fail("Decreasing service reading requires correct ID | VALUE | REASON before recording service.");r!.services.push({...entry,correctionReason:entry.meter!==null?r!.latestReason:""});if(entry.meter!==null){r!.latestMeter=entry.meter;r!.latestReason="";}if(r!.intervalDays!==null)checked(()=>addCivilDays(date,r!.intervalDays!));return saved(id,`Service ${entry.id} recorded; last baseline is recomputed from retained history.`,`history ${id}`);},"lifecycle");}
 if(verb==="history"){
  const action=/^(\S+)\s+(edit|remove|clear)\s+([\s\S]+)$/.exec(rest);
  if(action){const [,id,mode,input]=action;
   if(mode==="remove"||mode==="clear"){const v=words(input,mode==="remove"?2:3);if(v.at(-1)!=="confirm")fail("History removal/clearing requires confirm.");return mutate(context,id,(_,r)=>{const e=r!.services.find(s=>s.id===v[0]);if(!e)fail("Service not found in this asset.");if(mode==="remove")r!.services=r!.services.filter(s=>s!==e);else if(v[1]==="note"||v[1]==="correctionReason")e[v[1]]="";else if(v[1]==="meter")e.meter=null;else fail("History clear fields: meter, note, correctionReason. Remove the service to remove its date.");return saved(id,"Service history changed; baseline recomputed. A cleared correction reason must leave a monotonic history.",`history ${id}`);},"remove");}
   const [child,date,reading,note,reason]=fields(input,80,10,14,160,160);checked(()=>civilDate(date));if(date>dateInZone(context.now,context.timezone))fail("Service date cannot be in the future.");text(reason,"Correction reason",160);const meter=reading==="none"?null:usage(reading);text(note,"Note",160,true);return mutate(context,id,(_,r)=>{const e=r!.services.find(s=>s.id===child);if(!e)fail("Service not found in this asset.");Object.assign(e,{date,meter,note,correctionReason:reason});return saved(id,"Exact service corrected. Latest meter remains separately entered; due baseline recomputed.",`history ${id}`);});
  }
  const args=words(rest,1,4),r=find(await read(context),args[0]);const lines=[`Supplied manual: ${r.manual||"unknown"}`,`Last baseline: ${last(r)?.id??"unknown"}`,`Latest supplied meter: ${r.latestMeter===null?"unknown":units(r.latestMeter)}`];for(const s of r.services)lines.push(`${s.id} · ${s.date} · service meter ${s.meter===null?"unknown":units(s.meter)}`,`Note: ${s.note}`,`Correction reason: ${s.correctionReason||"none"}`);lines.push(`Next: ${ROUTE} show ${r.id}`);return report(lines,`history ${r.id}`,recordPage(r,`history ${r.id}`,args.slice(1)),`Private · complete service history · revision ${r.revision}`,pageVersion(r));
 }
 if(verb==="due"){const args=words(rest,1,4),day=checked(()=>civilDate(args[0])),s=await read(context),token=`1-${createHash("sha256").update(JSON.stringify(s)).digest("hex")}`,paging=args.slice(1);if(paging.length!==0&&paging.length!==1&&paging.length!==3)fail("Use due YYYY-MM-DD [PAGE [rev TOKEN]].");if(paging.length===3&&(paging[1]!=="rev"||paging[2]!==token))fail(`Saved data changed; stale continuation rejected. Restart: ${ROUTE} due ${day}`);return report([`Civil-date assessment: ${day}; latest reading has no invented observation time.`,...s.records.flatMap(r=>dueLines(r,day)),...(!s.records.length?[`No assets. Next: ${metadata.example}`]:[])],`due ${day}`,checked(()=>parsePage(paging[0])),"Private · supplied maintenance thresholds",token);}
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
